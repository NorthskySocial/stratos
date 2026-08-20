import { InvalidRequestError, Server as XrpcServer } from '@atproto/xrpc-server'
import { parseSpaceUri } from '@northskysocial/stratos-core'
import type { AppContext } from '../../context-types.js'
import { type XrpcServerInternal } from '../../api/types.js'
import { createXrpcHandler } from '../../api/util.js'
import {
  verifyDelegationToken,
  type DelegationVerifierDeps,
} from '../../infra/auth/delegation-verifier.js'
import { replayStoreFromCache } from '../../infra/auth/replay-store.js'
import { SpaceDpopProofChecker } from '../../infra/auth/space-dpop.js'
import {
  verifyClientAttestation,
  type ClientAttestationVerifierDeps,
} from '../../infra/auth/client-attestation-verifier.js'
import { resolveAppAccess, type AppAccess } from './app-access.js'
import { mintSpaceCredential } from './minter.js'

/**
 * XRPC method NSID for space-credential issuance.
 */
export const GET_SPACE_CREDENTIAL_METHOD =
  'zone.stratos.space.getSpaceCredential'

/**
 * Input body for {@link GET_SPACE_CREDENTIAL_METHOD}.
 */
interface GetSpaceCredentialInput {
  /** The space's `at://` URI to issue a credential for. */
  space?: string
  /** Optional space-delegation JWT (spec-shaped identity path). */
  delegationToken?: string
  /**
   * Optional client-attestation JWT. Required only for spaces gated on client
   * app identity (`appAccess#allowList`); ignored for `#open` spaces.
   */
  clientAttestation?: string
}

/**
 * Register the `zone.stratos.space.getSpaceCredential` handler.
 *
 * Method-auth binding: `optionalStandard`. Both supported identity paths must
 * flow through a single method, but only one of them (the DPoP path) presents
 * an `Authorization` header; the delegation-token path carries identity in the
 * request body. `standard` would hard-reject the delegation path (no header),
 * so we bind `optionalStandard` (which yields an authenticated `did` when a
 * valid DPoP session is present and `anonymous` otherwise) and perform explicit
 * identity resolution + rejection inside the handler.
 *
 * @param server - XRPC server.
 * @param ctx - Application context.
 */
export function registerSpaceCredentialHandlers(
  server: XrpcServer,
  ctx: AppContext,
): void {
  const xrpc = server as unknown as XrpcServerInternal
  const proofChecker = new SpaceDpopProofChecker(ctx.cfg.service.publicUrl)

  xrpc.method(GET_SPACE_CREDENTIAL_METHOD, {
    type: 'procedure',
    auth: ctx.authVerifier.optionalStandard,
    handler: createXrpcHandler<GetSpaceCredentialInput>(
      ctx,
      GET_SPACE_CREDENTIAL_METHOD,
      {
        // Both identity paths are resolved explicitly below; the delegation
        // path legitimately arrives with no authenticated DPoP `did`.
        requireAuth: false,
        handler: async ({ input, auth, req }) => {
          return handleGetSpaceCredential(
            ctx,
            input,
            auth?.credentials,
            req,
            proofChecker,
          )
        },
      },
    ),
  })
}

/** Minimal request shape needed to check a mint-time DPoP proof. */
interface MintRequest {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
}

/**
 * Core issuance logic for {@link GET_SPACE_CREDENTIAL_METHOD}.
 *
 * Steps (interim/DPoP path is live; delegation path is dormant):
 *   1. Require a `space` input.
 *   2. Parse `space` as an `at://` space URI; its `spaceDid` MUST equal
 *      our configured service DID → else {@link UnknownSpace}.
 *   3. Resolve identity: if a `delegationToken` is present, verify it
 *      (its target space MUST equal `space`) and take identity from it; else use
 *      the DPoP-authenticated user (reject anonymous).
 *   4. Map the space URI to its boundary, then confirm the user's enrollment is
 *      present AND active, and that it carries that boundary (live
 *      enrollment-store lookup, no cache) → else {@link NotEnrolled}.
 *   5. App-axis gating: if the space's `appAccess` is `#allowList`,
 *      require a valid client attestation whose attested `client_id` is listed
 *      (else `AttestationRequired` / `ClientNotAllowed`). `#open` spaces ignore
 *      any attestation supplied.
 *   6. Resolve the DPoP key thumbprint to bind (`cnf.jkt`): the session key on
 *      the DPoP path, or a standalone mint-time proof on the delegation path.
 *      Outside dev mode an unbound mint is rejected → {@link ProofRequired}.
 *   7. Mint the credential and return `{ credential, expiresAt }`.
 *
 * @param ctx - Application context.
 * @param input - Request body.
 * @param credentials - The caller's resolved auth credentials, if any.
 * @param req - The underlying request (for mint-time DPoP proof checks).
 * @param proofChecker - Nonce-free DPoP proof checker.
 * @returns `{ credential, expiresAt }`.
 */
async function handleGetSpaceCredential(
  ctx: AppContext,
  input: GetSpaceCredentialInput | undefined,
  credentials: { did?: string; jkt?: string } | undefined,
  req: MintRequest | undefined,
  proofChecker: SpaceDpopProofChecker,
): Promise<{ credential: string; expiresAt: string }> {
  const space = input?.space
  if (!space) {
    throw new InvalidRequestError('space parameter required', 'InvalidRequest')
  }

  // Space URI must be a valid `at://` space URI targeting THIS service.
  const parsed = parseSpaceUri(space)
  if (!parsed.ok || parsed.value.spaceDid !== ctx.serviceDid) {
    throw new InvalidRequestError(
      'Unknown space: URI must target this service',
      'UnknownSpace',
    )
  }
  const { spaceDid, skey } = parsed.value

  // Resolve identity via delegation token (dormant) or DPoP session (live).
  const userDid = input?.delegationToken
    ? await resolveDelegationIdentity(ctx, input.delegationToken, space)
    : requireDpopIdentity(credentials?.did)

  // Membership: the user must be enrolled in the boundary for this space.
  const boundary = `${spaceDid}/${skey}`

  // Boundary rows outlive deactivation, so a boundaries-only check would let a
  // suspended member keep minting credentials. Deny inactive enrollments first,
  // under the same NotEnrolled shape (no membership-status oracle).
  const enrollment = await ctx.enrollmentStore.getEnrollment(userDid)
  if (!enrollment || !enrollment.active) {
    throw new InvalidRequestError(
      'User is not enrolled in this space',
      'NotEnrolled',
    )
  }

  const boundaries = await ctx.enrollmentStore.getBoundaries(userDid)
  if (!boundaries.includes(boundary)) {
    throw new InvalidRequestError(
      'User is not enrolled in this space',
      'NotEnrolled',
    )
  }

  // App-axis (client attestation) gating. `#open` spaces are a no-op.
  await enforceAppAccess(ctx, boundary, input?.clientAttestation)

  // Key binding: the delegation path proves key possession with a standalone
  // mint-time DPoP proof; the DPoP path reuses the session proof's key.
  const jkt = input?.delegationToken
    ? await requireMintProofJkt(ctx, proofChecker, req)
    : credentials?.jkt
  if (!jkt && ctx.cfg.stratos.devMode !== true) {
    // Only dev-mode identities (dev Bearer) have no DPoP key. An unbound
    // credential in production would be freely replayable, so refuse.
    throw new InvalidRequestError(
      'A DPoP proof is required to bind the credential',
      'ProofRequired',
    )
  }

  const { credential, expiresAt } = await mintSpaceCredential({
    signingKey: ctx.signingKey,
    issuerDid: ctx.serviceDid,
    spaceUri: space,
    ttlSeconds: ctx.cfg.stratos.spaceCredentialTtlSeconds,
    jkt,
  })

  return { credential, expiresAt }
}

/**
 * Check the mint-time DPoP proof on the delegation path and return the proof
 * key's thumbprint. The proof is standalone (no bound token, so no `ath`
 * claim) — it proves possession of the key the credential will be bound to.
 *
 * @param ctx - Application context.
 * @param proofChecker - Nonce-free DPoP proof checker.
 * @param req - The underlying request.
 * @returns The proof key's SHA-256 JWK thumbprint.
 * @throws InvalidRequestError('ProofRequired') when the proof is missing or
 *   invalid (the exact reason is logged, not leaked).
 */
async function requireMintProofJkt(
  ctx: AppContext,
  proofChecker: SpaceDpopProofChecker,
  req: MintRequest | undefined,
): Promise<string> {
  try {
    const proof = await proofChecker.check({
      method: req?.method || 'POST',
      url: req?.url || '/',
      headers: req?.headers ?? {},
    })
    return proof.jkt
  } catch (err) {
    ctx.logger?.info(
      { err: err instanceof Error ? err.message : String(err) },
      'space-credential mint proof rejected',
    )
    throw new InvalidRequestError(
      'A DPoP proof is required to bind the credential',
      'ProofRequired',
    )
  }
}

/**
 * Verify a delegation token and return the delegating user's DID.
 *
 * Every verification failure — and a target-space mismatch — surfaces as
 * a single `InvalidToken` error code (the exact reason is logged, not leaked).
 *
 * @param ctx - Application context.
 * @param token - The raw delegation JWT.
 * @param requestedSpace - The `space` from the request; the token's target space
 *   MUST equal this.
 * @returns The delegating user's DID.
 * @throws InvalidRequestError('InvalidToken') on any failure.
 */
async function resolveDelegationIdentity(
  ctx: AppContext,
  token: string,
  requestedSpace: string,
): Promise<string> {
  const replayStore = replayStoreFromCache(ctx.cache, ctx.logger)
  if (!replayStore) {
    ctx.logger?.warn(
      'space-credential delegation path unavailable: no replay store (cache) configured',
    )
    throw new InvalidRequestError(
      'Delegation token could not be verified',
      'InvalidToken',
    )
  }

  const deps: DelegationVerifierDeps = {
    serviceDid: ctx.serviceDid,
    idResolver: ctx.idResolver,
    replayStore,
  }

  try {
    const result = await verifyDelegationToken(token, deps)
    if (result.spaceUri !== requestedSpace) {
      throw new InvalidRequestError(
        'Delegation token targets a different space',
        'InvalidToken',
      )
    }
    return result.userDid
  } catch (err) {
    if (err instanceof InvalidRequestError) throw err
    ctx.logger?.info(
      { err: err instanceof Error ? err.message : String(err) },
      'space-credential delegation token rejected',
    )
    throw new InvalidRequestError(
      'Delegation token could not be verified',
      'InvalidToken',
    )
  }
}

/**
 * Enforce app-axis (client attestation) gating for a space.
 *
 * Resolves the space's `appAccess` policy from service config:
 *   - `#open` (default for any unconfigured space): NO-OP — any supplied
 *     attestation is ignored.
 *   - `#allowList`: a client attestation is REQUIRED. It is verified in full
 *     (see {@link verifyClientAttestation}), and its *attested* `client_id`
 *     (`iss`) MUST be a member of the list.
 *
 * @throws InvalidRequestError('AttestationRequired') if the space is gated but
 *   no attestation was supplied, or it fails verification.
 * @throws InvalidRequestError('ClientNotAllowed') if a valid attestation's
 *   attested client_id is not in the allow-list.
 */
async function enforceAppAccess(
  ctx: AppContext,
  boundary: string,
  clientAttestation: string | undefined,
): Promise<void> {
  const access: AppAccess = resolveAppAccess(
    ctx.cfg.stratos.spaceAppAccess,
    boundary,
  )
  if (access.kind === 'open') {
    // Open space: ignore any attestation supplied.
    return
  }

  if (!clientAttestation) {
    throw new InvalidRequestError(
      'This space requires a client attestation',
      'AttestationRequired',
    )
  }

  const replayStore = replayStoreFromCache(ctx.cache, ctx.logger)
  if (!replayStore) {
    ctx.logger?.warn(
      'client attestation unavailable: no replay store (cache) configured',
    )
    throw new InvalidRequestError(
      'Client attestation could not be verified',
      'AttestationRequired',
    )
  }

  const deps: ClientAttestationVerifierDeps = {
    serviceDid: ctx.serviceDid,
    jwksResolver: ctx.jwksResolver,
    replayStore,
    logger: ctx.logger,
  }

  let clientId: string
  try {
    const result = await verifyClientAttestation(clientAttestation, deps)
    clientId = result.clientId
  } catch (err) {
    // Every verification failure surfaces as a single AttestationRequired code
    // (the exact reason is logged, not leaked), mirroring the delegation path.
    ctx.logger?.info(
      { err: err instanceof Error ? err.message : String(err) },
      'client attestation rejected',
    )
    throw new InvalidRequestError(
      'Client attestation could not be verified',
      'AttestationRequired',
    )
  }

  if (!access.clientIds.includes(clientId)) {
    throw new InvalidRequestError(
      'Client is not permitted to access this space',
      'ClientNotAllowed',
    )
  }
}

/**
 * Require a DPoP-authenticated identity, rejecting anonymous callers.
 *
 * @param dpopDid - The DPoP-authenticated user DID, if any.
 * @returns The user DID.
 * @throws InvalidRequestError('AuthRequired') if no identity is present.
 */
function requireDpopIdentity(dpopDid: string | undefined): string {
  if (!dpopDid) {
    throw new InvalidRequestError(
      'Authentication required: provide a DPoP session or a delegation token',
      'AuthRequired',
    )
  }
  return dpopDid
}
