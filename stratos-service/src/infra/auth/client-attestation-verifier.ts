import { compactVerify } from 'jose'
import type { Logger } from '@northskysocial/stratos-core'
import { decodeCompactJwt } from './jwt.js'
import {
  JwksResolutionError,
  MalformedJwksError,
  MetadataFetchError,
  NonHttpsClientIdError,
  UnknownKidError,
  type JwksResolver,
} from './jwks-resolver.js'
import type { ReplayStore } from './replay-store.js'

/**
 * Client-attestation verifier.
 *
 * A client attestation is, structurally, an OAuth `private_key_jwt` client
 * assertion presented BY a confidential client TO the space authority. It lets
 * the authority bind a `getSpaceCredential` request to a verified `client_id`
 * so app-gated spaces can enforce an allow-list against the *attested* client.
 *
 * Spec shape (implemented EXACTLY, in this order):
 *   - Header `typ` MUST be {@link CLIENT_ATTESTATION_TYP}.
 *   - Header `alg` MUST be present (used to import the resolved JWK).
 *   - Header `kid` MUST be present (names the client's JWKS key).
 *   - Payload `iss` MUST equal `sub` (both are the `client_id`).
 *   - `iss` MUST be a valid HTTPS URL (the client-metadata.json location).
 *   - Payload `aud` MUST be `${serviceDid}#atproto_space_host`.
 *   - `iat`/`exp` MUST be present, currently valid (with skew), and the
 *     attestation lifetime (`exp - iat`) MUST NOT exceed {@link MAX_LIFETIME_SECONDS}.
 *   - Signature MUST verify against the client's JWKS key named by `kid`
 *     (resolved via {@link JwksResolver}, fail-closed).
 *   - FINALLY the `jti` is consumed exactly once (replay protection).
 *
 * The `jti` is consumed LAST, and ONLY after every other check passes, so an
 * invalid attestation never burns its nonce — a later, genuinely valid
 * attestation bearing the same `jti` can still succeed.
 */

/** Required JWT `typ` header value for a client attestation. */
export const CLIENT_ATTESTATION_TYP = 'atproto-client-attestation+jwt'
/** Service fragment identifying the space-host audience. */
export const SPACE_HOST_FRAGMENT = '#atproto_space_host'
/** Replay-store namespace for client-attestation nonces. */
export const CLIENT_ATTESTATION_REPLAY_KIND = 'client-attestation'
/**
 * Replay-record TTL (seconds). Must exceed the max attestation lifetime
 * ({@link MAX_LIFETIME_SECONDS}) plus max clock skew, so an attestation can
 * never outlive its replay record.
 */
export const CLIENT_ATTESTATION_REPLAY_TTL = 360
/** Maximum permitted attestation lifetime (`exp - iat`) in seconds. */
export const MAX_LIFETIME_SECONDS = 300
/** Default clock-skew tolerance (seconds) for `iat`/`exp`. */
export const DEFAULT_CLOCK_SKEW = 30

/**
 * Base class for all client-attestation failures. Each distinct validation step
 * throws a distinct subclass so callers (and tests) can discriminate the exact
 * reason an attestation was rejected.
 */
export class ClientAttestationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** The token was structurally not a decodable JWT. */
export class MalformedAttestationError extends ClientAttestationError {}
/** Header `typ` was missing or not {@link CLIENT_ATTESTATION_TYP}. */
export class InvalidAttestationTypError extends ClientAttestationError {}
/** Header `alg` was missing. */
export class InvalidAttestationAlgError extends ClientAttestationError {}
/** Header `kid` was missing. */
export class InvalidAttestationKidError extends ClientAttestationError {}
/** `iss` was absent/empty, or `iss !== sub`. */
export class InvalidAttestationIssuerError extends ClientAttestationError {}
/** `iss` (the client_id) was not a valid HTTPS URL. */
export class NonHttpsClientError extends ClientAttestationError {}
/** `aud` was not `${serviceDid}#atproto_space_host`. */
export class InvalidAttestationAudError extends ClientAttestationError {}
/** `iat`/`exp` missing, malformed, expired, future, or lifetime > max. */
export class AttestationTimingError extends ClientAttestationError {}
/** Could not resolve the client's JWKS (fetch/shape/kid) — fail closed. */
export class AttestationKeyResolutionError extends ClientAttestationError {}
/** Signature did not verify against the client's `kid` key. */
export class InvalidAttestationSignatureError extends ClientAttestationError {}
/** `jti` missing/invalid, or already consumed (replay). */
export class AttestationReplayError extends ClientAttestationError {}

interface AttestationHeader {
  alg?: string
  typ?: string
  kid?: string
}

interface AttestationPayload {
  iss?: string
  sub?: string
  aud?: string
  iat?: number
  exp?: number
  jti?: string
}

/** Successful verification result. */
export interface ClientAttestationResult {
  /** The attested `client_id` (`iss` === `sub`), an HTTPS URL. */
  clientId: string
}

/** Dependencies for {@link verifyClientAttestation}. */
export interface ClientAttestationVerifierDeps {
  /** Our configured service DID (the attestation audience authority). */
  serviceDid: string
  /** Resolver for the client's published JWKS. */
  jwksResolver: JwksResolver
  /** Single-use nonce store (consumed LAST). */
  replayStore: ReplayStore
  /** Clock-skew tolerance in seconds (default {@link DEFAULT_CLOCK_SKEW}). */
  clockSkewSeconds?: number
  /** Optional logger. */
  logger?: Logger
}

/**
 * Verify a client-attestation JWT.
 *
 * Runs the checks in the exact order documented on this module. The `jti`
 * consumption is performed LAST — see the module doc for why ordering matters.
 *
 * @param token - The raw compact JWT (no `Bearer ` prefix).
 * @param deps - Verifier dependencies.
 * @returns `{ clientId }` (the attested `iss`/`sub`) on success.
 * @throws A distinct {@link ClientAttestationError} subclass per failure.
 */
export async function verifyClientAttestation(
  token: string,
  deps: ClientAttestationVerifierDeps,
): Promise<ClientAttestationResult> {
  const clockSkew = deps.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW
  const { header, payload } = decodeToken(token)

  // 1. typ
  if (header.typ !== CLIENT_ATTESTATION_TYP) {
    throw new InvalidAttestationTypError(
      `Invalid attestation typ: expected "${CLIENT_ATTESTATION_TYP}"`,
    )
  }

  // 2. alg (required to import the JWK)
  if (!header.alg) {
    throw new InvalidAttestationAlgError('Missing attestation alg header')
  }

  // 3. kid (names the client's JWKS key)
  if (!header.kid) {
    throw new InvalidAttestationKidError('Missing attestation kid header')
  }

  // 4. iss present and iss === sub
  if (!payload.iss) {
    throw new InvalidAttestationIssuerError('Missing iss claim')
  }
  if (payload.iss !== payload.sub) {
    throw new InvalidAttestationIssuerError(
      'Attestation iss must equal sub (both the client_id)',
    )
  }

  // 5. iss (client_id) must be a valid HTTPS URL
  const clientId = payload.iss
  requireHttpsUrl(clientId)

  // 6. aud — must be our space-host service fragment
  const expectedAud = `${deps.serviceDid}${SPACE_HOST_FRAGMENT}`
  if (payload.aud !== expectedAud) {
    throw new InvalidAttestationAudError(
      `Invalid aud claim: expected "${expectedAud}"`,
    )
  }

  // 7. iat / exp (with skew) + max lifetime
  validateTiming(payload, clockSkew)

  // 8. signature against the client's JWKS key named by kid (fail-closed resolve)
  await verifySignature(token, clientId, header.kid, header.alg, deps)

  // 9. jti — consumed LAST so an invalid attestation never burns its nonce
  if (!payload.jti) {
    throw new AttestationReplayError('Missing jti claim')
  }
  const fresh = await deps.replayStore.consumeOnce(
    CLIENT_ATTESTATION_REPLAY_KIND,
    payload.jti,
    CLIENT_ATTESTATION_REPLAY_TTL,
  )
  if (!fresh) {
    throw new AttestationReplayError('Attestation replay detected')
  }

  return { clientId }
}

/**
 * Split and base64url-decode the compact JWT into header + payload objects.
 *
 * @throws MalformedAttestationError if the token is not a decodable JWT.
 */
function decodeToken(token: string): {
  header: AttestationHeader
  payload: AttestationPayload
} {
  const { header, payload } = decodeCompactJwt<
    AttestationHeader,
    AttestationPayload
  >(token, (message) => new MalformedAttestationError(message))
  return { header, payload }
}

/** Require a syntactically valid HTTPS URL, else {@link NonHttpsClientError}. */
function requireHttpsUrl(clientId: string): void {
  let url: URL
  try {
    url = new URL(clientId)
  } catch {
    throw new NonHttpsClientError(`client_id is not a valid URL: "${clientId}"`)
  }
  if (url.protocol !== 'https:') {
    throw new NonHttpsClientError(
      `client_id must be an https URL: "${clientId}"`,
    )
  }
}

/**
 * Validate `iat`/`exp` against the current time with a symmetric skew window,
 * and enforce the maximum attestation lifetime.
 *
 * @throws AttestationTimingError on missing/malformed claims, expiry, a
 *   future `iat`, or a lifetime exceeding {@link MAX_LIFETIME_SECONDS}.
 */
function validateTiming(payload: AttestationPayload, clockSkew: number): void {
  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.iat !== 'number') {
    throw new AttestationTimingError('Missing or invalid iat claim')
  }
  if (typeof payload.exp !== 'number') {
    throw new AttestationTimingError('Missing or invalid exp claim')
  }
  if (payload.exp - payload.iat > MAX_LIFETIME_SECONDS) {
    throw new AttestationTimingError(
      `Attestation lifetime exceeds ${MAX_LIFETIME_SECONDS}s`,
    )
  }
  if (payload.iat > now + clockSkew) {
    throw new AttestationTimingError('Attestation iat is in the future')
  }
  if (now > payload.exp + clockSkew) {
    throw new AttestationTimingError('Attestation expired')
  }
}

/**
 * Resolve the client's JWKS key named by `kid` and verify the compact JWT's
 * signature against it.
 *
 * A JWKS-resolution failure (non-HTTPS, fetch failure, malformed doc, unknown
 * kid) fails CLOSED as {@link AttestationKeyResolutionError}; a resolved key
 * that does not validate the signature is {@link InvalidAttestationSignatureError}.
 */
async function verifySignature(
  token: string,
  clientId: string,
  kid: string,
  alg: string,
  deps: ClientAttestationVerifierDeps,
): Promise<void> {
  let key: Awaited<ReturnType<JwksResolver['resolveKey']>>
  try {
    key = await deps.jwksResolver.resolveKey(clientId, kid, alg)
  } catch (err) {
    if (err instanceof JwksResolutionError) {
      deps.logger?.info(
        { err: err.message, clientId, kind: keyErrorKind(err) },
        'client attestation JWKS resolution failed (fail closed)',
      )
      throw new AttestationKeyResolutionError(err.message)
    }
    throw err
  }

  try {
    await compactVerify(token, key)
  } catch (err) {
    throw new InvalidAttestationSignatureError(
      `Attestation signature did not verify: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** Coarse label for the JWKS-resolution failure, for diagnostics. */
function keyErrorKind(err: JwksResolutionError): string {
  if (err instanceof NonHttpsClientIdError) return 'non-https'
  if (err instanceof MetadataFetchError) return 'fetch'
  if (err instanceof MalformedJwksError) return 'malformed'
  if (err instanceof UnknownKidError) return 'unknown-kid'
  return 'unknown'
}
