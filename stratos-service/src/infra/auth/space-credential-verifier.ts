import type { Keypair } from '@atproto/crypto'
import * as crypto from '@atproto/crypto'
import { parseSpaceUri } from '@northskysocial/stratos-core'
import { decodeCompactJwt } from './jwt.js'

/**
 * Space-credential verifier (SWP-07).
 *
 * A **space credential** is a JWT the space authority (this Stratos service)
 * mints (see `features/space-credential/minter.ts`) to grant a member
 * bearer-shaped, **multi-use** access to a single space until the credential
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
 *     no `aud` claim and NO `jti` consumption (the credential is multi-use).
 *   - Payload `sub` MUST parse as a three-component `ats://` space URI whose
 *     `spaceDid` equals our configured service DID (we are the authority).
 *   - The signature MUST verify against OUR OWN service signing key.
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
/** `sub` was absent, malformed, or not a three-component space URI. */
export class InvalidSpaceCredentialSubError extends SpaceCredentialVerificationError {}
/** `sub`'s `spaceDid` did not match our configured service DID. */
export class ForeignSpaceCredentialError extends SpaceCredentialVerificationError {}
/** Signature did not verify against our own service signing key. */
export class InvalidSpaceCredentialSignatureError extends SpaceCredentialVerificationError {}

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
}

/** Successful verification result. */
export interface SpaceCredentialResult {
  /** The target space URI (`sub`), byte-for-byte as presented. */
  spaceUri: string
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

  return { spaceUri: payload.sub }
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
