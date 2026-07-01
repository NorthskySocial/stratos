import { InvalidRequestError, Server as XrpcServer } from '@atproto/xrpc-server'
import { parseSpaceUri, spaceUriToBoundary } from '@northskysocial/stratos-core'
import type { AppContext } from '../../context-types.js'
import { type XrpcServerInternal } from '../../api/types.js'
import { createXrpcHandler } from '../../api/util.js'
import {
  verifyDelegationToken,
  type DelegationVerifierDeps,
} from '../../infra/auth/delegation-verifier.js'
import { ReplayStore, type NxExStore } from '../../infra/auth/replay-store.js'
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
  /** Three-component `ats://` space URI to issue a credential for. */
  space?: string
  /** Optional space-delegation JWT (spec-shaped identity path). */
  delegationToken?: string
}

/**
 * Register the `zone.stratos.space.getSpaceCredential` handler (SWP-06).
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
        handler: async ({ input, auth }) => {
          return handleGetSpaceCredential(ctx, input, auth?.credentials?.did)
        },
      },
    ),
  })
}

/**
 * Core issuance logic for {@link GET_SPACE_CREDENTIAL_METHOD}.
 *
 * Steps (interim/DPoP path is live; delegation path is dormant):
 *   1. Require a `space` input.
 *   2. Parse `space` as a three-component space URI; its `spaceDid` MUST equal
 *      our configured service DID → else {@link UnknownSpace}.
 *   3. Resolve identity: if a `delegationToken` is present, verify it via SWP-05
 *      (its target space MUST equal `space`) and take identity from it; else use
 *      the DPoP-authenticated user (reject anonymous).
 *   4. Map the space URI to its boundary and confirm the user is enrolled in it
 *      (live enrollment-store lookup, no cache) → else {@link NotEnrolled}.
 *   5. Mint the credential and return `{ credential, expiresAt }`.
 *
 * App-axis (client attestation) gating is intentionally NOT enforced here; it
 * is SWP-08.
 *
 * @param ctx - Application context.
 * @param input - Request body.
 * @param dpopDid - The DPoP-authenticated user DID, if any.
 * @returns `{ credential, expiresAt }`.
 */
async function handleGetSpaceCredential(
  ctx: AppContext,
  input: GetSpaceCredentialInput | undefined,
  dpopDid: string | undefined,
): Promise<{ credential: string; expiresAt: string }> {
  const space = input?.space
  if (!space) {
    throw new InvalidRequestError('space parameter required', 'InvalidRequest')
  }

  // Space URI must be a valid three-component URI targeting THIS service.
  const parsed = parseSpaceUri(space)
  if (!parsed.ok || parsed.value.spaceDid !== ctx.serviceDid) {
    throw new InvalidRequestError(
      'Unknown space: URI must target this service',
      'UnknownSpace',
    )
  }

  // Resolve identity via delegation token (dormant) or DPoP session (live).
  const userDid = input?.delegationToken
    ? await resolveDelegationIdentity(ctx, input.delegationToken, space)
    : requireDpopIdentity(dpopDid)

  // Membership: the user must be enrolled in the boundary for this space.
  const boundaryResult = spaceUriToBoundary(space, ctx.serviceDid)
  if (!boundaryResult.ok) {
    // spaceDid already matched above, so this is not reachable in practice;
    // treat a mapping failure as an unknown space rather than a 500.
    throw new InvalidRequestError(
      'Unknown space: could not map to boundary',
      'UnknownSpace',
    )
  }
  const boundary = boundaryResult.value

  const boundaries = await ctx.enrollmentStore.getBoundaries(userDid)
  if (!boundaries.includes(boundary)) {
    throw new InvalidRequestError(
      'User is not enrolled in this space',
      'NotEnrolled',
    )
  }

  const { credential, expiresAt } = await mintSpaceCredential({
    signingKey: ctx.signingKey,
    issuerDid: ctx.serviceDid,
    spaceUri: space,
    ttlSeconds: ctx.cfg.stratos.spaceCredentialTtlSeconds,
  })

  return { credential, expiresAt }
}

/**
 * Verify a delegation token (SWP-05) and return the delegating user's DID.
 *
 * Every SWP-05 verification failure — and a target-space mismatch — surfaces as
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
  const replayStore = getReplayStore(ctx)
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

/**
 * Build a {@link ReplayStore} from the process cache for the dormant delegation
 * path. Returns undefined when no cache is configured (single-instance / no
 * Redis) — in that case the delegation path is unavailable and callers must use
 * the live DPoP path. The cast to {@link NxExStore} is a deliberate seam: the
 * runtime cache is a `RedisCache` exposing `setNxEx`, but the shared `Cache`
 * interface does not declare it.
 */
function getReplayStore(ctx: AppContext): ReplayStore | undefined {
  const cache = ctx.cache as (NxExStore & { setNxEx?: unknown }) | undefined
  if (!cache || typeof cache.setNxEx !== 'function') return undefined
  return new ReplayStore(cache, ctx.logger)
}
