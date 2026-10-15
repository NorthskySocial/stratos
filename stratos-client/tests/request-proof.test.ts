import { beforeAll, describe, expect, it } from 'vitest'
import { P256PrivateKey, Secp256k1PrivateKeyExportable } from '@atcute/crypto'
import { verifySignature } from '@atproto/crypto'
import { createHash } from 'node:crypto'
import {
  createRequestProof,
  requestProofReplayEntry,
  verifyRequestProof,
  type RequestProofContext,
} from '../src/request-proof.js'
import {
  decodeProofBytes,
  decodeProofObject,
  proofDigest,
  rejectProof,
  encodeProofBytes,
  proofUtf8,
} from '../src/request-proof-codec.js'

const key = await P256PrivateKey.importRaw(
  Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0)),
)
const kid = await key.exportPublicKey('did')
const context: RequestProofContext = {
  credential: 'ZXZh.bmVydg.c2hpbmpp',
  credentialKey: kid,
  authority: 'did:web:nerv.tokyo.jp',
  method: 'GET',
  target: '/xrpc/zone.stratos.space.getRecord?a=%2F&a=rei?',
  body: new Uint8Array(),
  now: 1000,
}
let proof: string
let header: Record<string, unknown>
let claims: Record<string, unknown>
const digest = (value: string) =>
  createHash('sha256').update(value).digest('base64url')
const segment = (value: unknown) =>
  encodeProofBytes(proofUtf8(JSON.stringify(value)))
async function signed(h = header, p = claims) {
  const input = `${segment(h)}.${segment(p)}`
  return `${input}.${encodeProofBytes(await key.sign(proofUtf8(input)))}`
}
async function signedText(h: string, p: string) {
  const input = `${encodeProofBytes(proofUtf8(h))}.${encodeProofBytes(proofUtf8(p))}`
  return `${input}.${encodeProofBytes(await key.sign(proofUtf8(input)))}`
}

beforeAll(async () => {
  proof =
    'eyJ0eXAiOiJzdHJhdG9zLXJlcXVlc3QtcHJvb2YtdjErand0IiwiYWxnIjoiRVMyNTYiLCJraWQiOiJkaWQ6a2V5OnpEbmFlcHNMN0FYZW5Ka1ZZZGtoNUt1S3NTVTdZa2g3a3lYYUxMVTdhdU45RldTaVoifQ.eyJhdWQiOiJkaWQ6d2ViOm5lcnYudG9reW8uanAiLCJodG0iOiJHRVQiLCJ0YXJnZXQiOiIveHJwYy96b25lLnN0cmF0b3Muc3BhY2UuZ2V0UmVjb3JkP2E9JTJGJmE9cmVpPyIsImF0aCI6Im9RWW0wRXUtd1UyX0F5U0NNb0VNbFNaTjl1YzBNYUdyV01BdHZXcXlhbVEiLCJib2R5X2hhc2giOiI0N0RFUXBqOEhCU2EtX1RJbVctNUpDZXVRZVJrbTVOTXBKV1pHM2hTdUZVIiwiaWF0IjoxMDAwLCJleHAiOjEwNjAsImp0aSI6IkFBRUNBd1FGQmdjSUNRb0xEQTBPRHcifQ.SWvlvgSIICg-cYFJ3MQL9Bn-pcqT0c0h1YVtJTlPEWtB8dYNl2Dy2-0hqzQAkyK-dZEcFq0Wl0FsdnDs6SJrNQ'
  const parts = proof.split('.')
  header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as Record<
    string,
    unknown
  >
  claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<
    string,
    unknown
  >
})

describe('request proof foundation', () => {
  it('verifies a fixed portable signature vector with independent crypto', async () => {
    const token =
      'eyJ0eXAiOiJzdHJhdG9zLXJlcXVlc3QtcHJvb2YtdjErand0IiwiYWxnIjoiRVMyNTYiLCJraWQiOiJkaWQ6a2V5OnpEbmFlcHNMN0FYZW5Ka1ZZZGtoNUt1S3NTVTdZa2g3a3lYYUxMVTdhdU45RldTaVoifQ.eyJhdWQiOiJkaWQ6d2ViOm5lcnYudG9reW8uanAiLCJodG0iOiJHRVQiLCJ0YXJnZXQiOiIveHJwYy96b25lLnN0cmF0b3Muc3BhY2UuZ2V0UmVjb3JkP2E9JTJGJmE9cmVpPyIsImF0aCI6Im9RWW0wRXUtd1UyX0F5U0NNb0VNbFNaTjl1YzBNYUdyV01BdHZXcXlhbVEiLCJib2R5X2hhc2giOiI0N0RFUXBqOEhCU2EtX1RJbVctNUpDZXVRZVJrbTVOTXBKV1pHM2hTdUZVIiwiaWF0IjoxMDAwLCJleHAiOjEwNjAsImp0aSI6IkFBRUNBd1FGQmdjSUNRb0xEQTBPRHcifQ.SWvlvgSIICg-cYFJ3MQL9Bn-pcqT0c0h1YVtJTlPEWtB8dYNl2Dy2-0hqzQAkyK-dZEcFq0Wl0FsdnDs6SJrNQ'
    const result = await verifyRequestProof(token, context)
    expect(result.claims.jti).toBe('AAECAwQFBgcICQoLDA0ODw')
    expect(result.claims.ath).toBe(digest(context.credential))
    const [h, p, s] = token.split('.')
    expect(
      await verifySignature(
        kid,
        proofUtf8(`${h}.${p}`),
        Buffer.from(s, 'base64url'),
        { allowMalleableSig: true },
      ),
    ).toBe(true)
  })

  it('binds exact request bytes and independently verifies ES256', async () => {
    const result = await verifyRequestProof(proof, context)
    expect(result.claims).toEqual({
      aud: context.authority,
      htm: 'GET',
      target: context.target,
      ath: digest(context.credential),
      body_hash: '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU',
      iat: 1000,
      exp: 1060,
      jti: claims.jti,
    })
    expect(Buffer.from(result.claims.jti, 'base64url')).toHaveLength(16)
    const [h, p, s] = proof.split('.')
    expect(
      await verifySignature(
        kid,
        proofUtf8(`${h}.${p}`),
        Buffer.from(s, 'base64url'),
        { allowMalleableSig: true },
      ),
    ).toBe(true)
    expect(result.principal).toBe(
      digest(
        JSON.stringify([context.authority, kid, digest(context.credential)]),
      ),
    )
    expect(result.replayId).toBe(
      digest(JSON.stringify([result.principal, claims.jti])),
    )
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.claims)).toBe(true)
    const next = await verifyRequestProof(
      await createRequestProof({ ...context, signingKey: key }),
      context,
    )
    expect(next.claims.jti).not.toBe(result.claims.jti)
  })

  it('accepts both S representatives with identical replay identity', async () => {
    const [h, p, s] = proof.split('.')
    const sig = Buffer.from(s, 'base64url')
    const n = BigInt(
      '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
    )
    const alternate = n - BigInt(`0x${sig.subarray(32).toString('hex')}`)
    sig.set(Buffer.from(alternate.toString(16).padStart(64, '0'), 'hex'), 32)
    expect(
      (
        await verifyRequestProof(
          `${h}.${p}.${sig.toString('base64url')}`,
          context,
        )
      ).replayId,
    ).toBe((await verifyRequestProof(proof, context)).replayId)
  })

  it('creates a proof when the signer returns a high-S signature', async () => {
    const n = BigInt(
      '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
    )
    const signingKey = {
      type: key.type,
      jwtAlg: key.jwtAlg,
      exportPublicKey: key.exportPublicKey.bind(key),
      verify: key.verify.bind(key),
      sign: async (input: Uint8Array) => {
        const signature = Buffer.from(await key.sign(input))
        const s = BigInt(`0x${signature.subarray(32).toString('hex')}`)
        signature.set(
          Buffer.from(
            (s > n / 2n ? s : n - s).toString(16).padStart(64, '0'),
            'hex',
          ),
          32,
        )
        expect(await key.verify(signature, input)).toBe(false)
        expect(
          await key.verify(signature, input, { allowMalleableSig: true }),
        ).toBe(true)
        return signature
      },
    }
    const token = await createRequestProof({
      ...context,
      signingKey,
    })
    const [h, p, s] = token.split('.')
    expect(
      BigInt(`0x${Buffer.from(s, 'base64url').subarray(32).toString('hex')}`),
    ).toBeGreaterThan(n / 2n)
    expect(
      await verifySignature(
        kid,
        proofUtf8(`${h}.${p}`),
        Buffer.from(s, 'base64url'),
        {
          allowMalleableSig: true,
        },
      ),
    ).toBe(true)
    expect((await verifyRequestProof(token, context)).credentialKey).toBe(kid)
  })

  it('preserves JSON order, escapes and insignificant whitespace without reserialization', async () => {
    const h = ` { "kid": ${JSON.stringify(kid)}, "alg":"ES256", "t\\u0079p":"stratos-request-proof-v1+jwt" } `
    const token = await signedText(h, JSON.stringify(claims, null, 1))
    expect((await verifyRequestProof(token, context)).claims.target).toBe(
      context.target,
    )
  })

  it.each([
    ['authority', 'did:web:seele.tokyo.jp'],
    ['method', 'POST'],
    ['target', '/xrpc/zone.stratos.space.getRecord?a=%2f&a=rei?'],
    ['target', '/xrpc/zone.stratos.space.getRecord?a=rei?&a=%2F'],
    ['credential', 'ZXZh.bmVydg.YXN1a2E'],
    ['credentialKey', `${kid}#key`],
    ['body', new Uint8Array([0])],
    ['contentEncoding', 'gzip'],
    ['now', 999.5],
  ])('rejects changed context %s=%s', async (name, value) => {
    await expect(
      verifyRequestProof(proof, { ...context, [name]: value }),
    ).rejects.toThrow()
  })

  it.each([
    '',
    '//nerv/path',
    'https://nerv/path',
    '*',
    '/a#b',
    '/a b',
    '/a\u007f',
    '/a\\b',
    '/é',
    '/a%',
    '/a%2',
    '/a%GG',
    '/a[0]',
    `/${'a'.repeat(2048)}`,
  ])('rejects malformed target %s', async (target) => {
    await expect(
      createRequestProof({ ...context, target, signingKey: key }),
    ).rejects.toThrow()
  })

  it.each(['/a%23%2F', '/a?b=1&b=2', '/a?', '/a?x=??', '/a/../b', '/a//b'])(
    'binds raw valid URI %s without normalization',
    async (target) => {
      const token = await createRequestProof({
        ...context,
        target,
        signingKey: key,
      })
      expect(
        (await verifyRequestProof(token, { ...context, target })).claims.target,
      ).toBe(target)
    },
  )

  it.each([
    { iat: 1006 },
    { iat: -1 },
    { iat: '1000' },
    { iat: 1000.5 },
    { exp: 1000 },
    { exp: 1061 },
    { exp: 995 },
    { exp: null },
    { exp: Number.MAX_SAFE_INTEGER + 1 },
    { aud: ['did:web:nerv.tokyo.jp'] },
    { aud: 12 },
    { htm: 'get' },
    { target: null },
    { ath: 'A'.repeat(43) },
    { body_hash: 'A'.repeat(43) },
    { jti: 'A'.repeat(21) },
    { jti: 'A'.repeat(21) + 'B' },
    { ath: 'A'.repeat(42) + 'B' },
    { unknown: true },
  ])('rejects invalid signed claims %j', async (changed) => {
    await expect(
      verifyRequestProof(
        await signed(header, { ...claims, ...changed }),
        context,
      ),
    ).rejects.toThrow()
  })

  it.each([
    { alg: 'none' },
    { alg: 'ES256K' },
    { typ: 'dpop+jwt' },
    { kid: `${kid}#key` },
    { jwk: {} },
    { crit: [] },
    { jku: 'https://nerv.tokyo.jp' },
  ])('rejects protected-header confusion %j', async (changed) => {
    await expect(
      verifyRequestProof(await signed({ ...header, ...changed }), context),
    ).rejects.toThrow()
  })

  it.each(['aud', 'htm', 'target', 'ath', 'body_hash', 'iat', 'exp', 'jti'])(
    'requires claim %s',
    async (field) => {
      const changed = { ...claims }
      delete changed[field]
      await expect(
        verifyRequestProof(await signed(header, changed), context),
      ).rejects.toThrow()
    },
  )

  it.each(['typ', 'alg', 'kid'])('requires header %s', async (field) => {
    const changed = { ...header }
    delete changed[field]
    await expect(
      verifyRequestProof(await signed(changed), context),
    ).rejects.toThrow()
  })

  it('enforces clock edges and rechecks fractional time for replay retention', async () => {
    for (const now of [995, 1064])
      expect(
        (await verifyRequestProof(proof, { ...context, now })).claims.iat,
      ).toBe(1000)
    for (const now of [994, 1065])
      await expect(
        verifyRequestProof(proof, { ...context, now }),
      ).rejects.toThrow()
    const verified = await verifyRequestProof(proof, context)
    expect(requestProofReplayEntry(verified, 1000.25)).toEqual({
      kind: 'stratos-request-proof-v1',
      jti: verified.replayId,
      ttlSeconds: 65,
    })
    expect(requestProofReplayEntry(verified, 1064.9).ttlSeconds).toBe(1)
    for (const now of [1065, NaN, Infinity, -1, 994])
      expect(() => requestProofReplayEntry(verified, now)).toThrow()
    for (const lifetimeSeconds of [0, -1, 61, 0.5, NaN])
      await expect(
        createRequestProof({ ...context, signingKey: key, lifetimeSeconds }),
      ).rejects.toThrow()
    expect(
      (
        await verifyRequestProof(
          await createRequestProof({
            ...context,
            signingKey: key,
            lifetimeSeconds: 1,
          }),
          context,
        )
      ).claims.exp,
    ).toBe(1001)
  })

  it('rejects duplicate JSON names after escape decoding', async () => {
    for (const h of [
      JSON.stringify(header).replace(
        '"alg":"ES256"',
        '"alg":"ES256","alg":"ES256"',
      ),
      JSON.stringify(header).replace(
        '"alg":"ES256"',
        '"alg":"ES256","a\\u006cg":"ES256"',
      ),
    ]) {
      await expect(
        verifyRequestProof(
          await signedText(h, JSON.stringify(claims)),
          context,
        ),
      ).rejects.toThrow()
    }
    const p = JSON.stringify(claims).replace('"iat":1000', '"iat":0,"iat":1000')
    await expect(
      verifyRequestProof(await signedText(JSON.stringify(header), p), context),
    ).rejects.toThrow()
  })

  it.each([
    'null',
    '[]',
    '{}',
    '{"typ":true}',
    '{"typ":{}}',
    '{"typ":"x",}',
    '\ufeff{}',
    '{"typ":"\u0000"}',
    ' { "typ":"x" } garbage',
  ])('rejects malformed or non-profile JSON %s', (value) => {
    expect(() =>
      decodeProofObject(encodeProofBytes(proofUtf8(value)), 512, ['typ']),
    ).toThrow()
  })

  it('rejects malformed UTF-8, compact encoding, sizes, and signature scalars', async () => {
    const [h, p, s] = proof.split('.')
    for (const token of [
      '',
      `${proof} `,
      ` ${proof}`,
      `${proof},${proof}`,
      `${proof}.x`,
      `${h}..${s}`,
      `${h}=.${p}.${s}`,
      `${h}.${p}.${s}=`,
      `${h}.${p}.AA`,
      `${h}.${p}.${encodeProofBytes(new Uint8Array(64))}`,
      `${encodeProofBytes(new Uint8Array([0xc0, 0x80]))}.${p}.${s}`,
      `${segment('x'.repeat(513))}.${p}.${s}`,
      `${h}.${segment('x'.repeat(4097))}.${s}`,
      'A'.repeat(8193),
    ]) {
      await expect(verifyRequestProof(token, context)).rejects.toThrow()
    }
    const sig = Buffer.from(s, 'base64url')
    sig[0] ^= 1
    await expect(
      verifyRequestProof(`${h}.${p}.${sig.toString('base64url')}`, context),
    ).rejects.toThrow()
  })

  it('rejects other curves and invalid points without network resolution', async () => {
    const other = await Secp256k1PrivateKeyExportable.createKeypair()
    for (const credentialKey of [
      await other.exportPublicKey('did'),
      'did:web:nerv.tokyo.jp',
      'did:key:z',
      `${kid}?x=1`,
    ]) {
      await expect(
        createRequestProof({ ...context, credentialKey, signingKey: key }),
      ).rejects.toThrow()
    }
    await expect(
      createRequestProof({ ...context, signingKey: other }),
    ).rejects.toThrow()
    await expect(
      createRequestProof({
        ...context,
        credential: 'a'.repeat(16385),
        signingKey: key,
      }),
    ).rejects.toThrow()
    await expect(
      createRequestProof({
        ...context,
        authority: 'did:web:nerv%GG',
        signingKey: key,
      }),
    ).rejects.toThrow()
  })
  it('checks codec results independently', async () => {
    expect(proofUtf8('Reié')).toEqual(new Uint8Array([82, 101, 105, 195, 169]))
    expect(await proofDigest(new Uint8Array([0, 255]))).toBe(
      createHash('sha256')
        .update(new Uint8Array([0, 255]))
        .digest('base64url'),
    )
    expect(() => rejectProof()).toThrow('Invalid Stratos request proof')
    expect(decodeProofBytes('AP8', 2)).toEqual(new Uint8Array([0, 255]))
    for (const [value, limit] of [
      ['AP8', 1],
      ['AAAA', 2],
      ['=AA', 2],
      ['AA=', 2],
      ['AB', 2],
      ['AA!', 2],
    ] as const)
      expect(() => decodeProofBytes(value, limit)).toThrow()
    for (const text of [
      '{"a":-12.345e+12}',
      '{"a":1E-12}',
      '{"a":1e12}',
      '{"a":"Rei"}',
    ])
      expect(
        decodeProofObject(encodeProofBytes(proofUtf8(text)), 512, ['a']),
      ).toEqual(JSON.parse(text))
    for (const bytes of [
      new Uint8Array([239, 187, 191, ...proofUtf8('{"a":"Rei"}')]),
      new Uint8Array([...proofUtf8('{"a":"'), 192, 128, ...proofUtf8('"}')]),
    ])
      expect(() =>
        decodeProofObject(encodeProofBytes(bytes), 512, ['a']),
      ).toThrow()
  })

  it('creates independently verifiable proofs at inclusive limits', async () => {
    for (const changes of [
      { authority: 'did:a:b' },
      { authority: 'did:web:a%2Fb%2F' },
      { authority: `did:web:${'a'.repeat(248)}` },
      { target: '/' },
      { target: `/${'a'.repeat(2047)}` },
      { target: '/a?x=%2F%23' },
      { credential: `${'a'.repeat(16380)}.a.a` },
      { contentEncoding: 'identity' },
      { now: 0 },
      { lifetimeSeconds: 17 },
    ]) {
      const options = { ...context, ...changes, signingKey: key }
      const token = await createRequestProof(options)
      const [h, p, sig] = token.split('.')
      expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
        typ: 'stratos-request-proof-v1+jwt',
        alg: 'ES256',
        kid,
      })
      expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toMatchObject({
        aud: options.authority,
        target: options.target,
        ath: digest(options.credential),
        iat: options.now,
        exp: options.now + (options.lifetimeSeconds ?? 60),
      })
      expect(
        await verifySignature(
          kid,
          Buffer.from(`${h}.${p}`),
          Buffer.from(sig, 'base64url'),
          { allowMalleableSig: true },
        ),
      ).toBe(true)
      expect((await verifyRequestProof(token, options)).credentialKey).toBe(kid)
    }
  })

  it.each([
    { authority: 'prefixdid:web:nerv' },
    { authority: 'did:WEB:nerv' },
    { authority: 'did:web:nerv:' },
    { authority: 'did:web:nerv/' },
    { authority: 'did:web:nerv%GGx' },
    { authority: 'did:web:nerv%2' },
    { authority: 'did:web:nerv%2x' },
    { authority: `did:web:${'a'.repeat(249)}` },
    { method: 'POST' },
    { method: '' },
    { credential: 'a.b' },
    { credential: '!a.b.c' },
    { credential: 'a.b.c!' },
    { credential: '!.b.c' },
    { credential: 'a.!.c' },
    { credential: 'a.b.!' },
    { credential: `${'a'.repeat(16381)}.a.a` },
    { body: new Uint8Array([1]) },
    { body: new ArrayBuffer(0) },
    { contentEncoding: '' },
    { contentEncoding: 'gzip' },
    { now: -1 },
    { now: NaN },
    { now: Infinity },
    { target: '/a?x=#bad' },
    { target: '/a?x=%GG' },
    { target: '/a?x=%2' },
    { target: '/a?x=[bad]' },
  ])('rejects isolated invalid creation input %j', async (changes) => {
    await expect(
      createRequestProof({
        ...context,
        ...changes,
        signingKey: key,
      } as unknown as Parameters<typeof createRequestProof>[0]),
    ).rejects.toThrow()
  })

  it('checks signer metadata and generated signature independently', async () => {
    const other = await P256PrivateKey.importRaw(
      Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 2 : 0)),
    )
    for (const signingKey of [
      other,
      {
        type: 'secp256k1',
        jwtAlg: 'ES256',
        exportPublicKey: async () => kid,
        sign: key.sign.bind(key),
      },
      {
        type: 'p256',
        jwtAlg: 'ES256K',
        exportPublicKey: async () => kid,
        sign: key.sign.bind(key),
      },
      {
        type: 'p256',
        jwtAlg: 'ES256',
        exportPublicKey: async () => kid,
        sign: async () => new Uint8Array(64),
      },
    ])
      await expect(
        createRequestProof({ ...context, signingKey } as unknown as Parameters<
          typeof createRequestProof
        >[0]),
      ).rejects.toThrow()
  })

  it('accepts zero issuance and rejects fractional expiry', async () => {
    const verified = await verifyRequestProof(
      await signed(header, { ...claims, iat: 0, exp: 60 }),
      { ...context, now: 0 },
    )
    expect(verified.claims.iat).toBe(0)
    await expect(
      verifyRequestProof(await signed(header, { ...claims, iat: 0, exp: 60 }), {
        ...context,
        now: -1,
      }),
    ).rejects.toThrow()
    expect(() => requestProofReplayEntry(verified, -1)).toThrow()
    expect(requestProofReplayEntry(verified, 0).ttlSeconds).toBe(65)
    expect(Object.isFrozen(requestProofReplayEntry(verified, 0))).toBe(true)
    await expect(
      verifyRequestProof(
        await signed(header, { ...claims, exp: 1001.5 }),
        context,
      ),
    ).rejects.toThrow()
  })
  it.each(['AP8', 'AAAA', '=AA', 'AA!', 'AB'])(
    'rejects byte encoding %s with an independent bound',
    (value) => {
      expect(() => decodeProofBytes(value, 1)).toThrow()
    },
  )

  it.each([
    String.raw`{"a":"\\\"\/\b\f\n\r\t\u0041"}`,
    String.raw`{"\u0061":"Rei"}`,
    String.raw`{"\"":"Rei"}`,
    String.raw`{"\\":"Rei"}`,
    String.raw`{"\/":"Rei"}`,
    String.raw`{"\b":"Rei"}`,
    String.raw`{"\f":"Rei"}`,
    String.raw`{"\n":"Rei"}`,
    String.raw`{"\r":"Rei"}`,
    String.raw`{"\t":"Rei"}`,
  ])('accepts native JSON escapes %s', (text) => {
    expect(
      decodeProofObject(
        Buffer.from(text).toString('base64url'),
        512,
        Object.keys(JSON.parse(text) as Record<string, unknown>),
      ),
    ).toEqual(JSON.parse(text))
  })

  it.each(['{"a":"Rei","a":"Asuka"}', '{"a":"Rei"}', '{"b":"Rei"}'])(
    'requires every distinct expected member %s',
    (text) => {
      expect(() =>
        decodeProofObject(Buffer.from(text).toString('base64url'), 512, [
          'a',
          'b',
        ]),
      ).toThrow()
    },
  )

  it.each([
    { authority: { length: 1, toString: (): string => 'did:web:nerv' } },
    { authority: '' },
    { credential: '' },
    { target: '' },
    { credentialKey: '' },
  ])('rejects non-profile runtime inputs %j', async (changes) => {
    await expect(
      createRequestProof({
        ...context,
        ...changes,
        signingKey: key,
      } as unknown as Parameters<typeof createRequestProof>[0]),
    ).rejects.toThrow()
  })

  it.each([
    '/?x=%GG',
    '/?x=[bad]',
    '/a?x=bad%GG/end',
    '/a?x=bad%2/end',
    '/a?x=bad[end',
    '/a#bad/end',
  ])('rejects invalid embedded target characters %s', async (target) => {
    await expect(
      createRequestProof({ ...context, target, signingKey: key }),
    ).rejects.toThrow()
  })

  it('rejects negative issuance inside an otherwise valid window', async () => {
    await expect(
      verifyRequestProof(
        await signed(header, { ...claims, iat: -1, exp: 59 }),
        { ...context, now: 0 },
      ),
    ).rejects.toThrow()
    const verified = await verifyRequestProof(proof, context)
    expect(() => requestProofReplayEntry(verified, -1)).toThrow()
  })

  it('accepts a credential key with the other compressed-point parity', async () => {
    const other = await P256PrivateKey.importRaw(
      Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 3 : 0)),
    )
    expect((await other.exportPublicKey('raw'))[0]).toBe(2)
    const options = {
      ...context,
      credentialKey: await other.exportPublicKey('did'),
      signingKey: other,
    }
    const token = await createRequestProof(options)
    expect((await verifyRequestProof(token, options)).credentialKey).toBe(
      options.credentialKey,
    )
  })

  it('requires the signer to declare the credential key even with a valid signature', async () => {
    const signingKey = {
      type: 'p256',
      jwtAlg: 'ES256',
      exportPublicKey: async () => 'did:key:unrelated',
      sign: key.sign.bind(key),
    }
    await expect(
      createRequestProof({ ...context, signingKey } as unknown as Parameters<
        typeof createRequestProof
      >[0]),
    ).rejects.toThrow()
  })
})
