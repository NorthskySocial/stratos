import { createHash, webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createDpopProof,
  dpopThumbprint,
  generateDpopKeyPair,
} from '../src/space-credential/dpop.js'

function decodeJwt(token: string): {
  header: Record<string, unknown>
  payload: Record<string, unknown>
  signingInput: string
  signatureB64: string
} {
  const [headerB64, payloadB64, signatureB64] = token.split('.')
  const decode = (s: string) =>
    JSON.parse(Buffer.from(s, 'base64url').toString('utf-8')) as Record<
      string,
      unknown
    >
  return {
    header: decode(headerB64),
    payload: decode(payloadB64),
    signingInput: `${headerB64}.${payloadB64}`,
    signatureB64,
  }
}

describe('generateDpopKeyPair', () => {
  it('produces a P-256 public JWK with crv, kty, x, y', async () => {
    const pair = await generateDpopKeyPair()
    expect(pair.jwk.kty).toBe('EC')
    expect(pair.jwk.crv).toBe('P-256')
    expect(typeof pair.jwk.x).toBe('string')
    expect(typeof pair.jwk.y).toBe('string')
  })

  it('keeps the private key inside the process', async () => {
    // The private half binds every credential through `cnf.jkt`. It never
    // needs to leave, so exporting it must fail.
    const pair = await generateDpopKeyPair()
    expect(pair.privateKey.extractable).toBe(false)
    await expect(
      webcrypto.subtle.exportKey('jwk', pair.privateKey),
    ).rejects.toThrow()
  })

  it('still exports the public JWK', async () => {
    const pair = await generateDpopKeyPair()
    expect(pair.jwk).toMatchObject({ kty: 'EC', crv: 'P-256' })
    expect(pair.jwk.x).toBeTruthy()
    expect(pair.jwk.y).toBeTruthy()
  })
})

describe('dpopThumbprint', () => {
  it('is deterministic for the same JWK', () => {
    const jwk = { crv: 'P-256', kty: 'EC', x: 'xxx', y: 'yyy' }
    expect(dpopThumbprint(jwk)).toBe(dpopThumbprint({ ...jwk }))
  })

  it('ignores member order (canonical JSON, RFC 7638)', () => {
    const jwk = { crv: 'P-256', kty: 'EC', x: 'xxx', y: 'yyy' }
    const reordered = { y: 'yyy', x: 'xxx', kty: 'EC', crv: 'P-256' }
    expect(dpopThumbprint(jwk)).toBe(dpopThumbprint(reordered))
  })

  it('differs for different keys', () => {
    const a = dpopThumbprint({ crv: 'P-256', kty: 'EC', x: 'aaa', y: 'bbb' })
    const b = dpopThumbprint({ crv: 'P-256', kty: 'EC', x: 'ccc', y: 'ddd' })
    expect(a).not.toBe(b)
  })
})

describe('createDpopProof', () => {
  it('produces a proof satisfying the space-surface checker shape (RFC 9449)', async () => {
    const key = await generateDpopKeyPair()
    const proof = await createDpopProof(key, {
      htm: 'POST',
      htu: 'https://stratos.test/xrpc/zone.stratos.space.getSpaceCredential?foo=bar',
    })
    const { header, payload, signingInput, signatureB64 } = decodeJwt(proof)

    expect(header).toEqual({ alg: 'ES256', typ: 'dpop+jwt', jwk: key.jwk })
    expect(payload.htm).toBe('POST')
    // Query/fragment stripped per RFC 9449 section 4.2.
    expect(payload.htu).toBe(
      'https://stratos.test/xrpc/zone.stratos.space.getSpaceCredential',
    )
    expect(typeof payload.jti).toBe('string')
    expect(typeof payload.iat).toBe('number')
    expect(payload.ath).toBeUndefined()

    const valid = await webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await webcrypto.subtle.importKey(
        'jwk',
        key.jwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      ),
      Buffer.from(signatureB64, 'base64url'),
      new TextEncoder().encode(signingInput),
    )
    expect(valid).toBe(true)
  })

  it('omits ath for a mint-time proof and includes it for a presentation proof', async () => {
    const key = await generateDpopKeyPair()
    const mintProof = await createDpopProof(key, {
      htm: 'POST',
      htu: 'https://stratos.test/xrpc/zone.stratos.space.getSpaceCredential',
    })
    const presentationProof = await createDpopProof(key, {
      htm: 'GET',
      htu: 'https://spaces-pds.test/xrpc/com.atproto.space.listRepoOps',
      credential: 'the-credential-jwt',
    })

    expect(decodeJwt(mintProof).payload.ath).toBeUndefined()

    const expectedAth = createHash('sha256')
      .update('the-credential-jwt')
      .digest('base64url')
    expect(decodeJwt(presentationProof).payload.ath).toBe(expectedAth)
  })

  it('encodes iat in epoch seconds, not milliseconds', async () => {
    const key = await generateDpopKeyPair()
    const before = Math.floor(Date.now() / 1000)
    const proof = await createDpopProof(key, {
      htm: 'GET',
      htu: 'https://stratos.test/x',
    })
    const after = Math.floor(Date.now() / 1000)
    const { payload } = decodeJwt(proof)
    expect(payload.iat).toBeGreaterThanOrEqual(before)
    expect(payload.iat).toBeLessThanOrEqual(after)
  })

  it('mints a distinct jti per proof', async () => {
    const key = await generateDpopKeyPair()
    const a = await createDpopProof(key, {
      htm: 'GET',
      htu: 'https://stratos.test/x',
    })
    const b = await createDpopProof(key, {
      htm: 'GET',
      htu: 'https://stratos.test/x',
    })
    expect(decodeJwt(a).payload.jti).not.toBe(decodeJwt(b).payload.jti)
  })
})
