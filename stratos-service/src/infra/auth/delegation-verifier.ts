import type { DidDocument, IdResolver } from '@atproto/identity'
import { parseSpaceUri } from '@northskysocial/stratos-core'
import {
  prepareVerificationData,
  resolveIssuerDid,
  verifyWithMethod,
} from './verifier.js'
import { decodeCompactJwt } from './jwt.js'
import type { ReplayStore } from './replay-store.js'

/**
 * Space-delegation token verifier.
 *
 * A delegation token is a JWT by which an account authorizes a space authority
 * to act on a specific space on its behalf. It is **single-use**: the verifier
 * consumes the token's `jti` so it can never be presented twice.
 *
 * Spec shape (implemented exactly, in order):
 *   - Header `typ` MUST be {@link DELEGATION_TYP}.
 *   - Header `alg` MUST be one of {@link ALLOWED_ALGS} (`ES256K`, `ES256`).
 *   - Header `kid` MUST be exactly {@link ATPROTO_KID} (`"#atproto"`).
 *   - Payload `sub` MUST parse as a three-component `ats://` space URI whose
 *     `spaceDid` equals our configured service DID (we are the authority).
 *   - Payload `aud` MUST be `${serviceDid}#atproto_space_host`.
 *   - Payload `iat`/`exp` MUST be present and currently valid (with skew).
 *   - The signature MUST verify against the issuer DID document's `#atproto`
 *     verification method **only** (no other method is accepted).
 *   - FINALLY the `jti` is consumed exactly once (replay protection).
 *
 * @see verifyDelegationToken
 */

/** Required JWT `typ` header value for a space-delegation token. */
export const DELEGATION_TYP = 'atproto-space-delegation+jwt'
/** Allowed JWT signature algorithms. */
export const ALLOWED_ALGS = ['ES256K', 'ES256'] as const
/** Required JWT `kid` header value (the account's atproto signing key). */
export const ATPROTO_KID = '#atproto'
/** Service fragment identifying the space-host audience. */
export const SPACE_HOST_FRAGMENT = '#atproto_space_host'
/** Replay-store namespace for delegation nonces. */
export const DELEGATION_REPLAY_KIND = 'space-delegation'
/** Default clock-skew tolerance (seconds) for `iat`/`exp`. */
export const DEFAULT_CLOCK_SKEW = 30
/**
 * Maximum accepted token lifetime (`exp - iat`, seconds). The spec default is
 * 60s; anything materially longer is rejected. This bounds the window a single
 * token can be replayed within and keeps the replay TTL sufficient to cover the
 * token's whole validity.
 */
export const MAX_DELEGATION_LIFETIME = 300
/**
 * Replay-record TTL (seconds). Must exceed the maximum token lifetime plus twice
 * the clock skew, so a token can never outlive its replay record (which would
 * silently re-enable "single-use" tokens once the record expires).
 */
export const DELEGATION_REPLAY_TTL =
  MAX_DELEGATION_LIFETIME + 2 * DEFAULT_CLOCK_SKEW

/**
 * Base class for all delegation-verification failures. Each distinct validation
 * step throws a distinct subclass so callers (and tests) can discriminate the
 * exact reason a token was rejected.
 */
export class DelegationVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** Header `typ` was missing or not {@link DELEGATION_TYP}. */
export class InvalidDelegationTypError extends DelegationVerificationError {}
/** Header `alg` was not one of {@link ALLOWED_ALGS}. */
export class InvalidDelegationAlgError extends DelegationVerificationError {}
/** Header `kid` was not {@link ATPROTO_KID}. */
export class InvalidDelegationKidError extends DelegationVerificationError {}
/** `sub` was absent, malformed, or not a three-component space URI. */
export class InvalidDelegationSubError extends DelegationVerificationError {}
/** `sub`'s `spaceDid` did not match our configured service DID. */
export class ForeignSpaceDidError extends DelegationVerificationError {}
/** `aud` was not `${serviceDid}#atproto_space_host`. */
export class InvalidDelegationAudError extends DelegationVerificationError {}
/** `iat`/`exp` were missing, malformed, or outside the valid window. */
export class DelegationTimingError extends DelegationVerificationError {}
/** Signature did not verify against the issuer's `#atproto` method. */
export class InvalidDelegationSignatureError extends DelegationVerificationError {}
/** `jti` was missing/invalid, or already consumed (replay). */
export class DelegationReplayError extends DelegationVerificationError {}
/** The token was structurally not a decodable JWT. */
export class MalformedDelegationTokenError extends DelegationVerificationError {}

interface DelegationHeader {
  alg?: string
  typ?: string
  kid?: string
}

interface DelegationPayload {
  iss?: string
  sub?: string
  aud?: string
  iat?: number
  exp?: number
  jti?: string
}

/** Successful verification result. */
export interface DelegationResult {
  /** The account DID that issued (and signed) the token (`iss`). */
  userDid: string
  /** The target space URI (`sub`), byte-for-byte as presented. */
  spaceUri: string
}

/** Dependencies for {@link verifyDelegationToken}. */
export interface DelegationVerifierDeps {
  /** Our configured service DID (the space authority). Must equal `sub.spaceDid`. */
  serviceDid: string
  /** Identity resolver for resolving the issuer DID document. */
  idResolver: IdResolver
  /** Single-use nonce store (consumed LAST). */
  replayStore: ReplayStore
  /** Clock-skew tolerance in seconds (default {@link DEFAULT_CLOCK_SKEW}). */
  clockSkewSeconds?: number
}

/**
 * Verify a space-delegation JWT.
 *
 * Runs the checks in the exact order documented on this module. The `jti`
 * consumption is performed **last, and only after every other check has
 * passed**, so an invalid token never burns its nonce — a later, genuinely
 * valid token bearing the same `jti` can still succeed.
 *
 * @param token - The raw compact JWT (no `Bearer ` prefix).
 * @param deps - Verifier dependencies.
 * @returns `{ userDid, spaceUri }` on success.
 * @throws A distinct {@link DelegationVerificationError} subclass per failure.
 */
export async function verifyDelegationToken(
  token: string,
  deps: DelegationVerifierDeps,
): Promise<DelegationResult> {
  const clockSkew = deps.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW
  const { parts, header, payload } = decodeToken(token)

  // 1. typ
  if (header.typ !== DELEGATION_TYP) {
    throw new InvalidDelegationTypError(
      `Invalid delegation token typ: expected "${DELEGATION_TYP}"`,
    )
  }

  // 2. alg
  if (
    !header.alg ||
    !(ALLOWED_ALGS as readonly string[]).includes(header.alg)
  ) {
    throw new InvalidDelegationAlgError(
      `Invalid delegation token alg: expected one of ${ALLOWED_ALGS.join(', ')}`,
    )
  }

  // 3. kid
  if (header.kid !== ATPROTO_KID) {
    throw new InvalidDelegationKidError(
      `Invalid delegation token kid: expected "${ATPROTO_KID}"`,
    )
  }

  // 4. sub — must parse as a space URI and target our service DID
  if (!payload.sub) {
    throw new InvalidDelegationSubError('Missing sub claim')
  }
  const parsed = parseSpaceUri(payload.sub)
  if (!parsed.ok) {
    throw new InvalidDelegationSubError(
      `Invalid sub claim: ${parsed.error.message}`,
    )
  }
  if (parsed.value.spaceDid !== deps.serviceDid) {
    throw new ForeignSpaceDidError(
      'Delegation sub targets a foreign space authority',
    )
  }

  // 5. aud — must be our space-host service fragment
  const expectedAud = `${deps.serviceDid}${SPACE_HOST_FRAGMENT}`
  if (payload.aud !== expectedAud) {
    throw new InvalidDelegationAudError(
      `Invalid aud claim: expected "${expectedAud}"`,
    )
  }

  // 6. iat / exp (with skew)
  validateTiming(payload, clockSkew)

  // 7. iss present + signature against #atproto verification method ONLY
  if (!payload.iss) {
    throw new InvalidDelegationSignatureError('Missing iss claim')
  }
  await verifyAtprotoSignature(parts, payload.iss, deps.idResolver)

  // 8. jti — consumed LAST so an invalid token never burns its nonce
  if (!payload.jti) {
    throw new DelegationReplayError('Missing jti claim')
  }
  const fresh = await deps.replayStore.consumeOnce(
    DELEGATION_REPLAY_KIND,
    payload.jti,
    DELEGATION_REPLAY_TTL,
  )
  if (!fresh) {
    throw new DelegationReplayError('Delegation token replay detected')
  }

  return { userDid: payload.iss, spaceUri: payload.sub }
}

/**
 * Split and base64url-decode the compact JWT into header + payload objects.
 *
 * @throws MalformedDelegationTokenError if the token is not a decodable JWT.
 */
function decodeToken(token: string): {
  parts: string[]
  header: DelegationHeader
  payload: DelegationPayload
} {
  return decodeCompactJwt<DelegationHeader, DelegationPayload>(
    token,
    (message) => new MalformedDelegationTokenError(message),
  )
}

/**
 * Validate `iat`/`exp` against the current time with a symmetric skew window.
 *
 * @throws DelegationTimingError if either claim is missing, malformed, the
 *   token is expired, or `iat` is too far in the future.
 */
function validateTiming(payload: DelegationPayload, clockSkew: number): void {
  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.iat !== 'number') {
    throw new DelegationTimingError('Missing or invalid iat claim')
  }
  if (typeof payload.exp !== 'number') {
    throw new DelegationTimingError('Missing or invalid exp claim')
  }
  if (payload.iat > now + clockSkew) {
    throw new DelegationTimingError('Delegation token iat is in the future')
  }
  if (now > payload.exp + clockSkew) {
    throw new DelegationTimingError('Delegation token expired')
  }
  if (payload.exp - payload.iat > MAX_DELEGATION_LIFETIME) {
    throw new DelegationTimingError(
      `Delegation token lifetime exceeds ${MAX_DELEGATION_LIFETIME}s`,
    )
  }
}

/**
 * Verify the JWT signature against the issuer DID document's `#atproto`
 * verification method **only**.
 *
 * Reuses the shared DID-resolution and single-method-verification plumbing from
 * `verifier.ts` (`resolveIssuerDid`, `prepareVerificationData`,
 * `verifyWithMethod`), but — unlike `verifyServiceAuth`, which tries every
 * method — selects exactly the `#atproto` method and rejects if it is absent or
 * fails. Signatures from any other verification method in the same document are
 * never accepted.
 *
 * @throws InvalidDelegationSignatureError if the DID cannot be resolved, has no
 *   `#atproto` method, or the signature does not verify against it.
 */
async function verifyAtprotoSignature(
  parts: string[],
  iss: string,
  idResolver: IdResolver,
): Promise<void> {
  let didDoc: DidDocument
  try {
    didDoc = await resolveIssuerDid(iss, idResolver)
  } catch {
    throw new InvalidDelegationSignatureError('Could not resolve issuer DID')
  }

  const method = selectAtprotoMethod(didDoc)
  if (!method) {
    throw new InvalidDelegationSignatureError(
      'Issuer DID document has no #atproto verification method',
    )
  }

  const { signingInputBytes, signatureBytes } = prepareVerificationData(parts)
  const verified = await verifyWithMethod(
    method,
    signingInputBytes,
    signatureBytes,
  )
  if (!verified) {
    throw new InvalidDelegationSignatureError('Invalid signature')
  }
}

/**
 * Select the verification method whose id fragment is `#atproto`, controlled by
 * the DID subject. Returns undefined if none is present.
 */
function selectAtprotoMethod(
  didDoc: DidDocument,
): NonNullable<DidDocument['verificationMethod']>[number] | undefined {
  const methods = didDoc.verificationMethod ?? []
  return methods.find((vm) => {
    const fragment = vm.id.startsWith('#')
      ? vm.id
      : vm.id.slice(didDoc.id.length)
    return fragment === ATPROTO_KID
  })
}
