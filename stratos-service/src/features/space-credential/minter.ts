import { randomUUID } from 'node:crypto'
import type { Keypair } from '@atproto/crypto'
import {
  SPACE_CREDENTIAL_KID,
  SPACE_CREDENTIAL_TYP,
} from '../../infra/auth/space-credential-verifier.js'

/**
 * Space-credential minter.
 *
 * A **space credential** is a JWT by which the space authority (this Stratos
 * service) grants a member bearer-shaped, **multi-use** access to a space until
 * the credential expires. Because it is signed by the authority's own signing
 * key, any repo host can verify it against the authority's published DID
 * document without ever contacting the authority.
 *
 * Spec shape (minted EXACTLY as below):
 *   - Header `typ` = {@link SPACE_CREDENTIAL_TYP} (`atproto-space-credential+jwt`).
 *   - Header `alg` = the signing keypair's `jwtAlg` — `ES256K` for the Stratos
 *     service Secp256k1 key (the spec permits `ES256K` or `ES256`).
 *   - Header `kid` = {@link ATPROTO_KID} (`"#atproto"`). The spec's fallback rule
 *     (`"#atproto_space"` OR `"#atproto"`) makes a dedicated `#atproto_space`
 *     entry unnecessary, so we always emit `#atproto`.
 *   - Payload `iss` = the space-authority DID (this service's DID).
 *   - Payload `sub` = the space's `at://` URI.
 *   - Payload `iat` = issuance time (unix seconds).
 *   - Payload `exp` = `iat + ttlSeconds` (2h default).
 *   - Payload `jti` = a unique nonce.
 *   - **No `aud` claim** — a space credential is not audience-bound; that is what
 *     makes it multi-use across any repo host.
 *
 * The compact JWT is produced by hand (base64url header + payload, signed with
 * `keypair.sign`) rather than via a JOSE library, mirroring how the codebase's
 * own service-auth/delegation JWTs are built and verified (see
 * `infra/auth/verifier.ts` and `infra/auth/delegation-verifier.ts`): the signing
 * input is `${b64url(header)}.${b64url(payload)}` and the signature is the raw
 * `keypair.sign` output, base64url-encoded.
 */

// The wire contract (typ/kid) is owned by the verifier so mint and verify can
// never drift — a mismatch would make the service reject its own credentials.
export { SPACE_CREDENTIAL_TYP }
/** JWT `kid` header value (the authority's atproto signing key). */
export const ATPROTO_KID = SPACE_CREDENTIAL_KID
/** Default credential lifetime in seconds (2h) per the spec. */
export const DEFAULT_SPACE_CREDENTIAL_TTL_SECONDS = 7_200

/** Header of a minted space credential. */
export interface SpaceCredentialHeader {
  typ: typeof SPACE_CREDENTIAL_TYP
  alg: string
  kid: typeof ATPROTO_KID
}

/** Payload (claim set) of a minted space credential. Note: no `aud`. */
export interface SpaceCredentialPayload {
  iss: string
  sub: string
  iat: number
  exp: number
  jti: string
}

/** Inputs to {@link mintSpaceCredential}. */
export interface MintSpaceCredentialInput {
  /** The space-authority signing keypair (this service's signing key). */
  signingKey: Keypair
  /** The space-authority DID → `iss`. */
  issuerDid: string
  /** The space's `at://` URI → `sub`. */
  spaceUri: string
  /** Credential lifetime in seconds → `exp = iat + ttlSeconds`. */
  ttlSeconds: number
  /**
   * Issuance time in unix seconds (`iat`). Defaults to now. Injectable so
   * callers/tests can pin `iat` and assert `exp - iat`.
   */
  iat?: number
  /** Unique nonce (`jti`). Defaults to a fresh random value. */
  jti?: string
}

/** Result of minting a space credential. */
export interface MintSpaceCredentialResult {
  /** The compact-serialized JWT. */
  credential: string
  /** The `exp` claim (unix seconds). */
  exp: number
  /** The `exp` claim as an ISO-8601 datetime, for the endpoint's `expiresAt`. */
  expiresAt: string
  /** The full decoded payload, for logging/tests. */
  payload: SpaceCredentialPayload
}

const b64urlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

/**
 * Mint (build + sign) a space-credential JWT per the embedded spec facts.
 *
 * @param input - Signing key, issuer/subject, TTL, and optional `iat`/`jti`.
 * @returns The compact JWT plus its `exp`/`expiresAt` and decoded payload.
 */
export async function mintSpaceCredential(
  input: MintSpaceCredentialInput,
): Promise<MintSpaceCredentialResult> {
  const iat = input.iat ?? Math.floor(Date.now() / 1000)
  const exp = iat + input.ttlSeconds
  const jti = input.jti ?? randomUUID()

  const header: SpaceCredentialHeader = {
    typ: SPACE_CREDENTIAL_TYP,
    alg: input.signingKey.jwtAlg,
    kid: ATPROTO_KID,
  }
  const payload: SpaceCredentialPayload = {
    iss: input.issuerDid,
    sub: input.spaceUri,
    iat,
    exp,
    jti,
  }

  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`
  const sig = await input.signingKey.sign(
    new TextEncoder().encode(signingInput),
  )
  const credential = `${signingInput}.${Buffer.from(sig).toString('base64url')}`

  return {
    credential,
    exp,
    expiresAt: new Date(exp * 1000).toISOString(),
    payload,
  }
}
