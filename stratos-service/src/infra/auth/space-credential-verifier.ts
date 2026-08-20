import type { Keypair } from '@atproto/crypto'
import * as crypto from '@atproto/crypto'
import type { DpopProof } from '@atproto/oauth-provider'
import { parseSpaceUri } from '@northskysocial/stratos-core'
import { decodeCompactJwt } from './jwt.js'
import type { VerifyRequestContext } from './dpop-verifier.js'
import type { SpaceDpopProofChecker } from './space-dpop.js'
import type { ReplayStore } from './replay-store.js'

/**
 * Space-credential verifier.
 *
 * A **space credential** is a JWT the space authority (this Stratos service)
 * mints (see `features/space-credential/minter.ts`) to grant a member
 * **multi-use**, DPoP-key-bound access to a single space until the credential
 * expires. On the read/sync surface we accept it as an ALTERNATIVE
 * authentication that COMPOSES with — never replaces — the per-record boundary
 * gate: a credential admits the caller to the API surface for its space, and
 * the existing gate still filters every returned record to those a member of
 * that space may see.
 *
 * Because WE are the space authority, we verify the signature against OUR OWN
 * service signing key (loaded locally from `ctx.signingKey`), with NO
 * DID-resolution round trip. This mirrors how the minter signs and how the
 * minter unit test verifies (`crypto.verifySignature(signingKey.did(), ...)`).
 *
 * Spec shape (verified exactly, in order):
 *   - Structurally a decodable compact JWT (three base64url parts).
 *   - Header `typ` MUST be {@link SPACE_CREDENTIAL_TYP}.
 *   - Header `alg` MUST be one of {@link SPACE_CREDENTIAL_ALLOWED_ALGS} (`ES256K`, `ES256`).
 *   - Header `kid` MUST be exactly {@link SPACE_CREDENTIAL_KID} (`"#atproto"`).
 *   - Payload `exp` MUST be present and not in the past (with skew). There is
 *     no `aud` claim and NO credential-`jti` consumption (the credential is
 *     multi-use; single-use applies to the per-request PROOF `jti` instead).
 *   - Payload `sub` MUST parse as an `at://` space URI whose
 *     `spaceDid` equals our configured service DID (we are the authority).
 *   - The signature MUST verify against OUR OWN service signing key.
 *
 * Presentation binding ({@link verifyPresentedSpaceCredential}) — the
 * credential is sender-constrained per RFC 9449:
 *   - Payload `cnf.jkt` MUST be present (the member's DPoP key thumbprint).
 *   - The request MUST carry a `DPoP` proof with `ath` over the credential and
 *     `htm`/`htu` matching the request.
 *   - The proof key's thumbprint MUST equal `cnf.jkt`.
 *   - The proof `jti` is consumed single-use (replay store, fail-closed) —
 *     LAST, so an invalid presentation never burns its nonce.
 *
 * @see verifySpaceCredential
 */

/** Required JWT `typ` header value for a space credential. */
export const SPACE_CREDENTIAL_TYP = 'atproto-space-credential+jwt'
/** Allowed JWT signature algorithms (the spec permits `ES256K` or `ES256`). */
export const SPACE_CREDENTIAL_ALLOWED_ALGS = ['ES256K', 'ES256'] as const
/** Required JWT `kid` header value (the authority's atproto signing key). */
export const SPACE_CREDENTIAL_KID = '#atproto'
/** Default clock-skew tolerance (seconds) for `exp`. */
export const SPACE_CREDENTIAL_CLOCK_SKEW = 30
/** Replay-store namespace for presentation-proof `jti` values. */
export const SPACE_DPOP_REPLAY_KIND = 'space-dpop'
/**
 * How long (seconds) a consumed proof `jti` is remembered. Covers the proof's
 * freshness window plus the checker's clock tolerance, so a proof can never
 * outlive its replay record.
 */
export const SPACE_DPOP_REPLAY_TTL = 300

/**
 * Base class for all space-credential-verification failures. Each distinct
 * validation step throws a distinct subclass so callers (and tests) can
 * discriminate the exact reason a credential was rejected.
 */
export class SpaceCredentialVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** The token was structurally not a decodable JWT. */
export class MalformedSpaceCredentialError extends SpaceCredentialVerificationError {}
/** Header `typ` was missing or not {@link SPACE_CREDENTIAL_TYP}. */
export class InvalidSpaceCredentialTypError extends SpaceCredentialVerificationError {}
/** Header `alg` was not one of {@link SPACE_CREDENTIAL_ALLOWED_ALGS}. */
export class InvalidSpaceCredentialAlgError extends SpaceCredentialVerificationError {}
/** Header `kid` was not {@link SPACE_CREDENTIAL_KID}. */
export class InvalidSpaceCredentialKidError extends SpaceCredentialVerificationError {}
/** `exp` was missing, malformed, or the credential has expired. */
export class SpaceCredentialExpiredError extends SpaceCredentialVerificationError {}
/** `sub` was absent, malformed, or not a valid space URI. */
export class InvalidSpaceCredentialSubError extends SpaceCredentialVerificationError {}
/** `sub`'s `spaceDid` did not match our configured service DID. */
export class ForeignSpaceCredentialError extends SpaceCredentialVerificationError {}
/** Signature did not verify against our own service signing key. */
export class InvalidSpaceCredentialSignatureError extends SpaceCredentialVerificationError {}
/** The credential carries no `cnf.jkt` key binding. */
export class MissingSpaceCredentialCnfError extends SpaceCredentialVerificationError {}
/** The request's `DPoP` proof was missing or failed validation. */
export class InvalidSpaceCredentialProofError extends SpaceCredentialVerificationError {}
/** The proof key's thumbprint did not equal the credential's `cnf.jkt`. */
export class SpaceCredentialKeyBindingError extends SpaceCredentialVerificationError {}
/** The proof `jti` was already consumed (or the replay store is unavailable). */
export class SpaceCredentialProofReplayError extends SpaceCredentialVerificationError {}

interface SpaceCredentialHeader {
  alg?: string
  typ?: string
  kid?: string
}

interface SpaceCredentialClaims {
  iss?: string
  sub?: string
  iat?: number
  exp?: number
  jti?: string
  cnf?: { jkt?: unknown }
}

/** Successful verification result. */
export interface SpaceCredentialResult {
  /** The target space URI (`sub`), byte-for-byte as presented. */
  spaceUri: string
  /** The `cnf.jkt` DPoP key binding, when the credential carries one. */
  cnfJkt?: string
}

/** Dependencies for {@link verifySpaceCredential}. */
export interface SpaceCredentialVerifierDeps {
  /**
   * Our own service signing keypair (the space authority). The signature is
   * verified against THIS key's public `did:key` — never via DID resolution.
   */
  serviceKey: Pick<Keypair, 'did'>
  /** Our configured service DID (the space authority). Must equal `sub.spaceDid`. */
  serviceDid: string
  /** Clock-skew tolerance in seconds (default {@link SPACE_CREDENTIAL_CLOCK_SKEW}). */
  clockSkewSeconds?: number
}

/**
 * Verify a space-credential JWT against our own service signing key.
 *
 * Runs the checks in the exact order documented on this module. There is NO
 * `jti` consumption: a space credential is deliberately multi-use, so it may be
 * presented repeatedly until it expires.
 *
 * @param token - The raw compact JWT (no `Bearer ` / scheme prefix).
 * @param deps - Verifier dependencies (our own key + service DID).
 * @returns `{ spaceUri }` on success.
 * @throws A distinct {@link SpaceCredentialVerificationError} subclass per failure.
 */
export async function verifySpaceCredential(
  token: string,
  deps: SpaceCredentialVerifierDeps,
): Promise<SpaceCredentialResult> {
  const clockSkew = deps.clockSkewSeconds ?? SPACE_CREDENTIAL_CLOCK_SKEW
  const { parts, header, payload } = decodeToken(token)

  // 1. typ
  if (header.typ !== SPACE_CREDENTIAL_TYP) {
    throw new InvalidSpaceCredentialTypError(
      `Invalid space credential typ: expected "${SPACE_CREDENTIAL_TYP}"`,
    )
  }

  // 2. alg
  if (
    !header.alg ||
    !(SPACE_CREDENTIAL_ALLOWED_ALGS as readonly string[]).includes(header.alg)
  ) {
    throw new InvalidSpaceCredentialAlgError(
      `Invalid space credential alg: expected one of ${SPACE_CREDENTIAL_ALLOWED_ALGS.join(', ')}`,
    )
  }

  // 3. kid
  if (header.kid !== SPACE_CREDENTIAL_KID) {
    throw new InvalidSpaceCredentialKidError(
      `Invalid space credential kid: expected "${SPACE_CREDENTIAL_KID}"`,
    )
  }

  // 4. exp (with skew) — no `aud`, no `jti` (multi-use)
  if (typeof payload.exp !== 'number') {
    throw new SpaceCredentialExpiredError('Missing or invalid exp claim')
  }
  const now = Math.floor(Date.now() / 1000)
  if (now > payload.exp + clockSkew) {
    throw new SpaceCredentialExpiredError('Space credential expired')
  }

  // 5. sub — must parse as a space URI targeting our service DID.
  if (!payload.sub) {
    throw new InvalidSpaceCredentialSubError('Missing sub claim')
  }
  const parsed = parseSpaceUri(payload.sub)
  if (!parsed.ok) {
    throw new InvalidSpaceCredentialSubError(
      `Invalid sub claim: ${parsed.error.message}`,
    )
  }
  if (parsed.value.spaceDid !== deps.serviceDid) {
    throw new ForeignSpaceCredentialError(
      'Space credential sub targets a foreign space authority',
    )
  }

  // 6. signature against OUR OWN service key (no DID resolution).
  await verifyOwnKeySignature(parts, deps.serviceKey)

  const cnfJkt = payload.cnf?.jkt
  return {
    spaceUri: payload.sub,
    ...(typeof cnfJkt === 'string' && cnfJkt ? { cnfJkt } : {}),
  }
}

/** Dependencies for {@link verifyPresentedSpaceCredential}. */
export interface PresentedSpaceCredentialDeps
  extends SpaceCredentialVerifierDeps {
  /** RFC 9449 proof checker for the space surface (nonce-free). */
  proofChecker: Pick<SpaceDpopProofChecker, 'check'>
  /** Single-use store for proof `jti` values (fail-closed). */
  replayStore: Pick<ReplayStore, 'consumeOnce'>
}

/**
 * Verify a space credential presented under the `DPoP` auth scheme.
 *
 * Runs {@link verifySpaceCredential} first, then enforces the sender
 * constraint: `cnf.jkt` presence, a valid `DPoP` proof with `ath` over the
 * credential, thumbprint equality, and single-use proof-`jti` consumption.
 * The `jti` is consumed LAST so an invalid presentation never burns its nonce.
 *
 * @param token - The raw compact credential JWT (no scheme prefix).
 * @param req - The request context the proof must bind (`htm`/`htu`).
 * @param deps - Credential deps plus the proof checker and replay store.
 * @returns `{ spaceUri, cnfJkt }` on success.
 * @throws A distinct {@link SpaceCredentialVerificationError} subclass per failure.
 */
export async function verifyPresentedSpaceCredential(
  token: string,
  req: VerifyRequestContext,
  deps: PresentedSpaceCredentialDeps,
): Promise<SpaceCredentialResult> {
  const result = await verifySpaceCredential(token, deps)

  // 7. cnf.jkt — every presented credential must be key-bound.
  if (!result.cnfJkt) {
    throw new MissingSpaceCredentialCnfError(
      'Space credential has no cnf.jkt key binding',
    )
  }

  // 8. DPoP proof — signature, typ, freshness, htm/htu, ath over the credential.
  let proof: DpopProof
  try {
    proof = await deps.proofChecker.check(req, token)
  } catch (err) {
    throw new InvalidSpaceCredentialProofError(
      err instanceof Error ? err.message : 'Invalid DPoP proof',
    )
  }

  // 9. key binding — the proof key must be the bound key.
  if (proof.jkt !== result.cnfJkt) {
    throw new SpaceCredentialKeyBindingError('DPoP key binding mismatch')
  }

  // 10. proof jti — consumed LAST so an invalid presentation never burns it.
  const fresh = await deps.replayStore.consumeOnce(
    SPACE_DPOP_REPLAY_KIND,
    proof.jti,
    SPACE_DPOP_REPLAY_TTL,
  )
  if (!fresh) {
    throw new SpaceCredentialProofReplayError('DPoP proof replay detected')
  }

  return result
}

/**
 * Split and base64url-decode the compact JWT into header + payload objects.
 *
 * @throws MalformedSpaceCredentialError if the token is not a decodable JWT.
 */
function decodeToken(token: string): {
  parts: string[]
  header: SpaceCredentialHeader
  payload: SpaceCredentialClaims
} {
  return decodeCompactJwt<SpaceCredentialHeader, SpaceCredentialClaims>(
    token,
    (message) => new MalformedSpaceCredentialError(message),
  )
}

/**
 * Verify the JWT signature against our own service key's public `did:key`.
 *
 * The signing input is `${parts[0]}.${parts[1]}` (byte-identical to the
 * minter), the signature is the base64url-decoded third part, and verification
 * uses `crypto.verifySignature(serviceKey.did(), ...)` — the exact inverse of
 * the minter. No DID document is resolved.
 *
 * @throws InvalidSpaceCredentialSignatureError if the signature does not verify.
 */
async function verifyOwnKeySignature(
  parts: string[],
  serviceKey: Pick<Keypair, 'did'>,
): Promise<void> {
  const signingInput = `${parts[0]}.${parts[1]}`
  const signingInputBytes = new TextEncoder().encode(signingInput)
  const signatureBytes = new Uint8Array(Buffer.from(parts[2], 'base64url'))

  let verified: boolean
  try {
    verified = await crypto.verifySignature(
      serviceKey.did(),
      signingInputBytes,
      signatureBytes,
    )
  } catch {
    verified = false
  }
  if (!verified) {
    throw new InvalidSpaceCredentialSignatureError('Invalid signature')
  }
}
