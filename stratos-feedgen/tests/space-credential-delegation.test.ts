import { describe, expect, it } from 'vitest'
import { Secp256k1Keypair, verifySignature } from '@atproto/crypto'
import {
  DELEGATION_TOKEN_LIFETIME_SECONDS,
  mintDelegationToken,
} from '../src/space-credential/delegation.js'

function decodeJwt(token: string): {
  header: Record<string, unknown>
  payload: Record<string, unknown>
} {
  const [headerB64, payloadB64] = token.split('.')
  const decode = (s: string) =>
    JSON.parse(Buffer.from(s, 'base64url').toString('utf-8')) as Record<
      string,
      unknown
    >
  return { header: decode(headerB64), payload: decode(payloadB64) }
}

const FEEDGEN_DID = 'did:web:feedgen.test'
const STRATOS_DID = 'did:web:stratos.test'
const SPACE_URI =
  'at://did:web:stratos.test/space/zone.stratos.space.feed/spike'

describe('mintDelegationToken', () => {
  it('produces the shape verifyDelegationToken expects', async () => {
    const key = await Secp256k1Keypair.create({ exportable: true })
    const before = Math.floor(Date.now() / 1000)
    const token = await mintDelegationToken({
      signingKey: key,
      issuerDid: FEEDGEN_DID,
      spaceUri: SPACE_URI,
      authorityDid: STRATOS_DID,
    })
    const after = Math.floor(Date.now() / 1000)
    const { header, payload } = decodeJwt(token)

    expect(header).toEqual({
      typ: 'atproto-space-delegation+jwt',
      alg: key.jwtAlg,
      kid: '#atproto',
    })
    expect(payload.iss).toBe(FEEDGEN_DID)
    expect(payload.sub).toBe(SPACE_URI)
    expect(payload.aud).toBe(`${STRATOS_DID}#atproto_space_host`)
    expect(typeof payload.jti).toBe('string')
    expect(payload.iat).toBeGreaterThanOrEqual(before)
    expect(payload.iat).toBeLessThanOrEqual(after)
    expect(payload.exp).toBe(
      (payload.iat as number) + DELEGATION_TOKEN_LIFETIME_SECONDS,
    )
  })

  it('is verifiable with the signing key\u2019s own public key', async () => {
    const key = await Secp256k1Keypair.create({ exportable: true })
    const token = await mintDelegationToken({
      signingKey: key,
      issuerDid: FEEDGEN_DID,
      spaceUri: SPACE_URI,
      authorityDid: STRATOS_DID,
    })
    const [headerB64, payloadB64, sigB64] = token.split('.')
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    const sig = Buffer.from(sigB64, 'base64url')
    const valid = await verifySignature(key.did(), signingInput, sig, {
      jwtAlg: key.jwtAlg,
    })
    expect(valid).toBe(true)
  })

  it('mints a distinct jti per token', async () => {
    const key = await Secp256k1Keypair.create({ exportable: true })
    const a = await mintDelegationToken({
      signingKey: key,
      issuerDid: FEEDGEN_DID,
      spaceUri: SPACE_URI,
      authorityDid: STRATOS_DID,
    })
    const b = await mintDelegationToken({
      signingKey: key,
      issuerDid: FEEDGEN_DID,
      spaceUri: SPACE_URI,
      authorityDid: STRATOS_DID,
    })
    expect(decodeJwt(a).payload.jti).not.toBe(decodeJwt(b).payload.jti)
  })
})
