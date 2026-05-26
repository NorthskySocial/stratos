import { Keypair } from '@atproto/crypto'
import { createServiceJwt } from '@atproto/xrpc-server'

/** Lifetime of service auth JWTs minted by the feed generator, in seconds. */
export const SERVICE_JWT_LIFETIME_SECONDS = 60

export interface MintServiceJwtOptions {
  /** Lexicon method (e.g. `zone.stratos.identity.resolveEnrollments`). */
  lxm: string
  /** Issuer DID — the feed generator's service identity. */
  iss: string
  /** Audience DID — the upstream Stratos service identity. */
  aud: string
  /** Keypair used to sign the JWT. */
  keypair: Keypair
}

/**
 * Mint a fresh service-auth JWT for a single upstream call.
 *
 * Tokens are short-lived (60 s) and never cached — call this per request
 * so issuance and exp align with the actual request time.
 */
export async function mintServiceJwt(
  opts: MintServiceJwtOptions,
): Promise<string> {
  return createServiceJwt({
    iss: opts.iss,
    aud: opts.aud,
    lxm: opts.lxm,
    keypair: opts.keypair,
  })
}
