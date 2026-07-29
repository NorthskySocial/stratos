/**
 * Shared helpers for minting client attestations and standing up a JWKS
 * resolver over a mocked fetch. Used by the attestation-verifier unit tests and
 * the getSpaceCredential app-gating contract tests. NO live network.
 */
import { CompactSign, exportJWK, generateKeyPair } from 'jose'
import type { KeyObject } from 'node:crypto'
import { JwksResolver } from '../../src/infra/auth/jwks-resolver.js'
import { CLIENT_ATTESTATION_TYP } from '../../src/infra/auth/client-attestation-verifier.js'

const enc = new TextEncoder()

/** A generated client signing identity + its published metadata URL. */
export interface ClientIdentity {
  clientId: string
  kid: string
  privateKey: KeyObject
  publicJwk: Record<string, unknown>
}

let clientCounter = 0

/**
 * Generate an ES256 client identity. `clientId` is a distinct HTTPS metadata
 * URL; the public JWK is tagged with a `kid`.
 */
export async function makeClient(kid = 'key-1'): Promise<ClientIdentity> {
  const clientId = `https://client-${clientCounter++}.example/client-metadata.json`
  const { privateKey, publicKey } = await generateKeyPair('ES256', {
    extractable: true,
  })
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    kid,
    alg: 'ES256',
    use: 'sig',
  }
  return {
    clientId,
    kid,
    privateKey: privateKey as unknown as KeyObject,
    publicJwk,
  }
}

/** Options for {@link mintAttestation}; every field is overridable for negatives. */
export interface MintAttestationOpts {
  client: ClientIdentity
  serviceDid: string
  typ?: string
  alg?: string
  kid?: string
  iss?: string
  sub?: string
  aud?: string
  iat?: number
  exp?: number
  jti?: string
  /** When true, sign with a *different* key than the published JWK. */
  wrongKey?: KeyObject
}

let jtiCounter = 0

/**
 * Mint a client-attestation compact JWS with full control over header/claims,
 * signed (by default) with the client's private key so it verifies against the
 * published JWK.
 */
export async function mintAttestation(
  opts: MintAttestationOpts,
): Promise<string> {
  const iat = opts.iat ?? Math.floor(Date.now() / 1000)
  const header = {
    typ: opts.typ ?? CLIENT_ATTESTATION_TYP,
    alg: opts.alg ?? 'ES256',
    kid: opts.kid ?? opts.client.kid,
  }
  const payload = {
    iss: opts.iss ?? opts.client.clientId,
    sub: opts.sub ?? opts.client.clientId,
    aud: opts.aud ?? `${opts.serviceDid}#atproto_space_host`,
    iat,
    exp: opts.exp ?? iat + 120,
    jti: opts.jti ?? `att-${Date.now()}-${jtiCounter++}`,
  }
  const signKey = opts.wrongKey ?? opts.client.privateKey
  return new CompactSign(enc.encode(JSON.stringify(payload)))
    .setProtectedHeader(header)
    .sign(signKey)
}

/**
 * Build a real {@link JwksResolver} over a mocked fetch that serves each
 * client's inline `jwks`. `failFetch` clients simulate a JWKS fetch failure.
 */
export function resolverFor(
  clients: ClientIdentity[],
  opts: { failFetch?: string[]; cacheTtlMs?: number } = {},
): JwksResolver {
  const fail = new Set(opts.failFetch ?? [])
  const byUrl = new Map(clients.map((c) => [c.clientId, c]))
  const fetch = async (input: string) => {
    const url = input.toString()
    const client = byUrl.get(url)
    if (!client || fail.has(url)) {
      throw new Error(`simulated fetch failure for ${url}`)
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ jwks: { keys: [client.publicJwk] } }),
    } as Response
  }
  return new JwksResolver({
    fetch: fetch as unknown as typeof globalThis.fetch,
    cacheTtlMs: opts.cacheTtlMs,
  })
}
