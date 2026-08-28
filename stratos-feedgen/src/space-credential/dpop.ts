import { createHash, randomUUID, webcrypto } from 'node:crypto'

/**
 * RFC 9449 DPoP proof construction for the space-credential surface.
 *
 * Mirrors the pattern proven against the real alpha PDS in
 * `test/spike/spaces/b3-feedgen-foreign-ingest.ts`: a P-256 key made with
 * `node:crypto`'s `webcrypto`, so the feedgen needs no JOSE dependency. The
 * server-side checker this must satisfy is
 * `stratos-service/src/infra/auth/space-dpop.ts`.
 */

const EC_KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const
const EC_SIGN_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const
const DPOP_PROOF_TYP = 'dpop+jwt'
const DPOP_SIGNING_ALG = 'ES256'

/** The public coordinates of a P-256 DPoP key, in RFC 7638 canonical order. */
export interface DpopJwk {
  readonly crv: string
  readonly kty: string
  readonly x: string
  readonly y: string
}

/** A generated DPoP signing key: the private key plus its public JWK. */
export interface DpopKeyPair {
  readonly privateKey: webcrypto.CryptoKey
  readonly jwk: DpopJwk
}

/** Generate a fresh P-256 DPoP key pair. */
export async function generateDpopKeyPair(): Promise<DpopKeyPair> {
  const pair = await webcrypto.subtle.generateKey(EC_KEY_ALGORITHM, true, [
    'sign',
    'verify',
  ])
  const publicJwk = (await webcrypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )) as { crv: string; kty: string; x: string; y: string }
  return {
    privateKey: pair.privateKey,
    jwk: {
      crv: publicJwk.crv,
      kty: publicJwk.kty,
      x: publicJwk.x,
      y: publicJwk.y,
    },
  }
}

/**
 * RFC 7638 SHA-256 JWK thumbprint. Member order is canonical for an EC key
 * (`crv`, `kty`, `x`, `y`).
 */
export function dpopThumbprint(jwk: DpopJwk): string {
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  })
  return createHash('sha256').update(canonical).digest('base64url')
}

/** Inputs to {@link createDpopProof}. */
export interface CreateDpopProofOptions {
  /** HTTP method the proof covers. */
  htm: string
  /** Target URL; query and fragment are stripped per RFC 9449 section 4.2. */
  htu: string
  /** The credential to bind via `ath`. Omit for a mint-time (unbound) proof. */
  credential?: string
}

/**
 * Build and sign a DPoP proof JWT for `key`.
 *
 * Omitting `credential` produces a mint-time proof (no `ath`), which is what
 * `zone.stratos.space.getSpaceCredential` requires on the delegation-token
 * path. Supplying it produces a presentation proof bound to that credential.
 */
export async function createDpopProof(
  key: DpopKeyPair,
  opts: CreateDpopProofOptions,
): Promise<string> {
  const url = new URL(opts.htu)
  const claims: Record<string, unknown> = {
    jti: randomUUID(),
    htm: opts.htm,
    htu: url.origin + url.pathname,
    iat: Math.floor(Date.now() / 1000),
  }
  if (opts.credential !== undefined) {
    claims.ath = createHash('sha256')
      .update(opts.credential)
      .digest('base64url')
  }
  const header = { alg: DPOP_SIGNING_ALG, typ: DPOP_PROOF_TYP, jwk: key.jwk }
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`
  const signature = await webcrypto.subtle.sign(
    EC_SIGN_ALGORITHM,
    key.privateKey,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}
