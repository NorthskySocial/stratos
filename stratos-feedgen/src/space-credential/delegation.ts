import { randomUUID } from 'node:crypto'
import type { Keypair } from '@atproto/crypto'

/**
 * Self-minted `atproto-space-delegation+jwt` tokens.
 *
 * The feedgen has a `did:web` identity and no PDS, so it cannot use the PDS
 * convenience endpoint for a delegation token. It signs its own, exactly as
 * proven against the real verifier in
 * `test/spike/spaces/a3-feedgen-delegation.ts`. The server-side spec this
 * must satisfy is `stratos-service/src/infra/auth/delegation-verifier.ts`.
 */

const DELEGATION_TYP = 'atproto-space-delegation+jwt'
const ATPROTO_KID = '#atproto'
const SPACE_HOST_FRAGMENT = '#atproto_space_host'

/**
 * Delegation token lifetime, in seconds. The verifier's `MAX_DELEGATION_LIFETIME`
 * is 300s, checked with a strict `>`; matching it leaves zero headroom against
 * clock drift between the feedgen and Stratos. A single-use token redeemed
 * inside one round trip does not need that much room, so this uses the spec's
 * own 60s default instead.
 */
export const DELEGATION_TOKEN_LIFETIME_SECONDS = 60

/** Inputs to {@link mintDelegationToken}. */
export interface MintDelegationTokenInput {
  /** The feedgen's own signing key (`iss` is derived from `issuerDid`, not the key). */
  signingKey: Keypair
  /** The feedgen's `did:web` identity — the delegation's `iss`. */
  issuerDid: string
  /** The space URI the feedgen is requesting a credential for — the delegation's `sub`. */
  spaceUri: string
  /** The Stratos space authority's DID — the delegation's `aud` is derived from this. */
  authorityDid: string
}

/**
 * Mint a single-use delegation token authorizing Stratos to resolve the
 * feedgen's identity for {@link MintDelegationTokenInput.spaceUri}.
 */
export async function mintDelegationToken(
  input: MintDelegationTokenInput,
): Promise<string> {
  const { signingKey, issuerDid, spaceUri, authorityDid } = input
  const iat = Math.floor(Date.now() / 1000)
  const header = {
    typ: DELEGATION_TYP,
    alg: signingKey.jwtAlg,
    kid: ATPROTO_KID,
  }
  const payload = {
    iss: issuerDid,
    sub: spaceUri,
    aud: `${authorityDid}${SPACE_HOST_FRAGMENT}`,
    iat,
    exp: iat + DELEGATION_TOKEN_LIFETIME_SECONDS,
    jti: randomUUID(),
  }
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`
  const signature = await signingKey.sign(
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}
