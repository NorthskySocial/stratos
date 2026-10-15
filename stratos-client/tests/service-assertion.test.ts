import { beforeAll, describe, expect, it, vi } from 'vitest'
import { P256PrivateKey, Secp256k1PrivateKeyExportable } from '@atcute/crypto'
import { createRequestProof } from '../src/request-proof.js'
import {
  createServiceAssertion,
  verifyServiceAssertion,
} from '../src/service-assertion.js'
import { encodeProofBytes, proofUtf8 } from '../src/request-proof-codec.js'

const key = await P256PrivateKey.importRaw(
  Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0)),
)
const request = {
  credential: 'ZXZh.bmVydg.c2hpbmpp',
  credentialKey: await key.exportPublicKey('did'),
  authority: 'did:web:nerv.tokyo.jp',
  method: 'GET',
  target: '/xrpc/zone.stratos.space.getRecord?a=%2F&a=rei?',
  body: new Uint8Array(),
  now: 1000,
}
let proof: string
const context = {
  proof: '',
  request,
  issuer: 'did:web:rei.nerv.jp',
  lxm: 'zone.stratos.space.getRecord',
}
const kid = `${context.issuer}#atproto`
let assertion: string
beforeAll(async () => {
  proof =
    'eyJ0eXAiOiJzdHJhdG9zLXJlcXVlc3QtcHJvb2YtdjErand0IiwiYWxnIjoiRVMyNTYiLCJraWQiOiJkaWQ6a2V5OnpEbmFlcHNMN0FYZW5Ka1ZZZGtoNUt1S3NTVTdZa2g3a3lYYUxMVTdhdU45RldTaVoifQ.eyJhdWQiOiJkaWQ6d2ViOm5lcnYudG9reW8uanAiLCJodG0iOiJHRVQiLCJ0YXJnZXQiOiIveHJwYy96b25lLnN0cmF0b3Muc3BhY2UuZ2V0UmVjb3JkP2E9JTJGJmE9cmVpPyIsImF0aCI6Im9RWW0wRXUtd1UyX0F5U0NNb0VNbFNaTjl1YzBNYUdyV01BdHZXcXlhbVEiLCJib2R5X2hhc2giOiI0N0RFUXBqOEhCU2EtX1RJbVctNUpDZXVRZVJrbTVOTXBKV1pHM2hTdUZVIiwiaWF0IjoxMDAwLCJleHAiOjEwNjAsImp0aSI6IkFBRUNBd1FGQmdjSUNRb0xEQTBPRHcifQ.SWvlvgSIICg-cYFJ3MQL9Bn-pcqT0c0h1YVtJTlPEWtB8dYNl2Dy2-0hqzQAkyK-dZEcFq0Wl0FsdnDs6SJrNQ'
  context.proof = proof
  const header = { typ: 'stratos-service-assertion-v1+jwt', alg: 'ES256', kid }
  const payload = {
    iss: context.issuer,
    aud: request.authority,
    iat: 1000,
    exp: 1060,
    lxm: context.lxm,
    proof_hash: (await import('node:crypto'))
      .createHash('sha256')
      .update(proof)
      .digest('base64url'),
  }
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
  assertion = `${input}.${Buffer.from(await key.sign(Buffer.from(input))).toString('base64url')}`
})

const resolver = { resolve: vi.fn(async () => key) }
const decode = (part: string) =>
  JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
        c.charCodeAt(0),
      ),
    ),
  ) as Record<string, unknown>
async function changed(section: number, changes: Record<string, unknown>) {
  const parts = assertion.split('.')
  parts[section] = encodeProofBytes(
    proofUtf8(JSON.stringify({ ...decode(parts[section]), ...changes })),
  )
  const input = `${parts[0]}.${parts[1]}`
  return `${input}.${encodeProofBytes(await key.sign(proofUtf8(input)))}`
}

describe('service assertion foundation', () => {
  it('verifies real ES256 and ES256K assertions without a new key purpose', async () => {
    expect(
      await verifyServiceAssertion(assertion, context, resolver),
    ).toMatchObject({ issuer: context.issuer, kid })
    const other = await Secp256k1PrivateKeyExportable.createKeypair()
    const token = await createServiceAssertion({
      ...context,
      kid,
      signingKey: other,
    })
    expect(
      (
        await verifyServiceAssertion(token, context, {
          resolve: async () => other,
        })
      ).proof.claims.aud,
    ).toBe(request.authority)
  })

  it.each([
    [0, { typ: 'JWT' }],
    [0, { alg: 'none' }],
    [0, { alg: 'ES256K' }],
    [0, { kid: '#atproto' }],
    [0, { kid: 'did:web:asuka.nerv.jp#atproto' }],
    [0, { kid: `${context.issuer}#` }],
    [0, { kid: `${context.issuer}#bad%GG` }],
    [0, { jwk: 'x' }],
    [1, { iss: 'did:web:asuka.nerv.jp' }],
    [1, { aud: 'did:web:seele.jp' }],
    [1, { iat: 999 }],
    [1, { exp: 1059 }],
    [1, { iat: '1000' }],
    [1, { lxm: 'zone.stratos.space.listRepos' }],
    [1, { proof_hash: 'A'.repeat(43) }],
    [1, { jti: 'x' }],
  ] as const)(
    'rejects profile or binding substitution %j %j',
    async (section, changes) => {
      await expect(
        verifyServiceAssertion(
          await changed(section, changes),
          context,
          resolver,
        ),
      ).rejects.toThrow()
    },
  )

  it('rejects proof substitution, invalid client signatures and stale proofs', async () => {
    const next = await createRequestProof({ ...request, signingKey: key })
    for (const ctx of [
      { ...context, proof: next },
      { ...context, proof: `${proof.slice(0, -10)}AAAAAAAAAA` },
      { ...context, request: { ...request, now: 1065 } },
      {
        ...context,
        request: { ...request, credential: 'ZXZh.bmVydg.YXN1a2E' },
      },
    ])
      await expect(
        verifyServiceAssertion(assertion, ctx, resolver),
      ).rejects.toThrow()
  })

  it('rejects key/algorithm confusion, resolver failure and bad signatures', async () => {
    const other = await Secp256k1PrivateKeyExportable.createKeypair()
    await expect(
      verifyServiceAssertion(assertion, context, {
        resolve: async () => other,
      }),
    ).rejects.toThrow()
    await expect(
      verifyServiceAssertion(assertion, context, {
        resolve: async () => {
          throw new Error('unavailable')
        },
      }),
    ).rejects.toThrow()
    const parts = assertion.split('.')
    for (const token of [
      '',
      'a'.repeat(4097),
      `${assertion} `,
      `${assertion},${assertion}`,
      `${parts[0]}.${parts[1]}.AA`,
      `${parts[0]}.${parts[1]}.${encodeProofBytes(new Uint8Array(64))}`,
      `${assertion}.extra`,
    ])
      await expect(
        verifyServiceAssertion(token, context, resolver),
      ).rejects.toThrow()
  })

  it('rejects duplicate decoded members and missing members', async () => {
    const [h, p, s] = assertion.split('.')
    const duplicate = new TextDecoder()
      .decode(Uint8Array.from(atob(h), (c) => c.charCodeAt(0)))
      .replace('"alg":"ES256"', '"alg":"ES256","a\\u006cg":"ES256"')
    await expect(
      verifyServiceAssertion(
        `${encodeProofBytes(proofUtf8(duplicate))}.${p}.${s}`,
        context,
        resolver,
      ),
    ).rejects.toThrow()
    for (const [section, fields] of [
      [0, ['typ', 'alg', 'kid']],
      [1, ['iss', 'aud', 'iat', 'exp', 'lxm', 'proof_hash']],
    ] as const) {
      for (const field of fields) {
        const parts = assertion.split('.')
        const object = decode(parts[section])
        delete object[field]
        parts[section] = encodeProofBytes(proofUtf8(JSON.stringify(object)))
        await expect(
          verifyServiceAssertion(parts.join('.'), context, resolver),
        ).rejects.toThrow()
      }
    }
  })

  it.each([
    { issuer: 'did:web:bad%GG' },
    { issuer: 'x'.repeat(257) },
    { lxm: 'zone..bad' },
    { lxm: 'zone.stratos.bad-name' },
  ])('rejects malformed trusted identity inputs %j', async (changes) => {
    await expect(
      createServiceAssertion({ ...context, ...changes, kid, signingKey: key }),
    ).rejects.toThrow()
  })
  it('asserts producer wire values independently', async () => {
    const [h, p, sig] = assertion.split('.')
    expect(decode(h)).toEqual({
      typ: 'stratos-service-assertion-v1+jwt',
      alg: 'ES256',
      kid,
    })
    expect(decode(p)).toEqual({
      iss: context.issuer,
      aud: request.authority,
      iat: 1000,
      exp: 1060,
      lxm: context.lxm,
      proof_hash: (await import('node:crypto'))
        .createHash('sha256')
        .update(proof)
        .digest('base64url'),
    })
    expect(
      await key.verify(
        Buffer.from(sig, 'base64url'),
        Buffer.from(`${h}.${p}`),
        { allowMalleableSig: true },
      ),
    ).toBe(true)
    const result = await verifyServiceAssertion(assertion, context, resolver)
    expect(Object.isFrozen(result)).toBe(true)
    expect(resolver.resolve).toHaveBeenCalledWith(context.issuer, kid)
  })

  it('enforces signer and resolver algorithm metadata independently', async () => {
    const secp = await Secp256k1PrivateKeyExportable.createKeypair()
    for (const [type, jwtAlg] of [
      ['p256', 'ES256K'],
      ['secp256k1', 'ES256'],
      ['p256', 'none'],
    ] as const) {
      const signingKey = {
        type,
        jwtAlg,
        sign: key.sign.bind(key),
        verify: key.verify.bind(key),
      }
      await expect(
        createServiceAssertion({
          ...context,
          kid,
          signingKey,
        } as unknown as Parameters<typeof createServiceAssertion>[0]),
      ).rejects.toThrow()
      await expect(
        verifyServiceAssertion(assertion, context, {
          resolve: async () => signingKey,
        }),
      ).rejects.toThrow()
    }
    const token = await createServiceAssertion({
      ...context,
      kid,
      signingKey: secp,
    })
    await expect(
      verifyServiceAssertion(token, context, {
        resolve: async () => ({
          type: 'p256',
          jwtAlg: 'ES256K',
          verify: secp.verify.bind(secp),
        }),
      }),
    ).rejects.toThrow()
    for (const signingKey of [
      {
        type: 'p256',
        jwtAlg: 'ES256',
        sign: async () => new Uint8Array(64),
        verify: async () => false,
      },
      {
        type: 'p256',
        jwtAlg: 'ES256',
        sign: async () => new Uint8Array(63),
        verify: async () => true,
      },
    ])
      await expect(
        createServiceAssertion({
          ...context,
          kid,
          signingKey,
        } as unknown as Parameters<typeof createServiceAssertion>[0]),
      ).rejects.toThrow()
  })

  it.each([
    { issuer: 'prefixdid:web:rei' },
    { issuer: 'did:WEB:rei' },
    { issuer: 'did:web:rei:' },
    { issuer: 'did:web:rei/' },
    { issuer: 'did:web:rei%GGx' },
    { issuer: 'did:web:rei%2' },
    { issuer: 'did:web:rei%2x' },
    { issuer: `did:web:${'a'.repeat(249)}` },
    { lxm: '1zone.stratos.record' },
    { lxm: 'zone.stratos.1record' },
    { lxm: 'zone-.stratos.record' },
    { lxm: 'zone.stratos.record!' },
    { lxm: 'zone.record' },
    { lxm: `zone.stratos.${'a'.repeat(64)}` },
    { lxm: `${'a'.repeat(64)}.stratos.record` },
    {
      lxm: `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.a`,
    },
    { lxm: 'zone.stratos.re cord' },
  ])('rejects isolated identity bounds %j', async (changes) => {
    const options = { ...context, ...changes }
    await expect(
      createServiceAssertion({
        ...options,
        kid: `${options.issuer}#atproto`,
        signingKey: key,
      }),
    ).rejects.toThrow()
  })

  it('accepts inclusive identity limits and URI fragments', async () => {
    for (const changes of [
      { issuer: 'did:a:b' },
      { issuer: 'did:web:a%2Fb%2F' },
      { issuer: `did:web:${'a'.repeat(248)}` },
      { lxm: 'a.b.c' },
      { lxm: `zone.stratos.${'a'.repeat(63)}` },
      { lxm: `${'a'.repeat(63)}.stratos.record` },
      {
        lxm: `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}`,
      },
    ]) {
      const ctx = { ...context, ...changes }
      const token = await createServiceAssertion({
        ...ctx,
        kid: `${ctx.issuer}#a%2F`,
        signingKey: key,
      })
      expect((await verifyServiceAssertion(token, ctx, resolver)).issuer).toBe(
        ctx.issuer,
      )
    }
    const longKid = `${context.issuer}#${'a'.repeat(511 - context.issuer.length)}`
    expect(
      (
        await verifyServiceAssertion(
          await createServiceAssertion({
            ...context,
            kid: longKid,
            signingKey: key,
          }),
          context,
          resolver,
        )
      ).kid,
    ).toBe(longKid)
    for (const invalidKid of [
      longKid + 'a',
      `${context.issuer}#a#b`,
      `${context.issuer}#a%2`,
      `${context.issuer}#a b`,
      `did:web:asuka.nerv.jp#atproto`,
      `${'x'.repeat(context.issuer.length)}!atproto`,
    ])
      await expect(
        createServiceAssertion({
          ...context,
          kid: invalidKid,
          signingKey: key,
        }),
      ).rejects.toThrow()
  })

  it('accepts either service signature S representative', async () => {
    const [h, p, s] = assertion.split('.')
    const signature = Buffer.from(s, 'base64url')
    const n = BigInt(
      '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
    )
    for (const scalar of [
      BigInt(`0x${signature.subarray(32).toString('hex')}`),
      n - BigInt(`0x${signature.subarray(32).toString('hex')}`),
    ]) {
      signature.set(
        Buffer.from(scalar.toString(16).padStart(64, '0'), 'hex'),
        32,
      )
      expect(
        (
          await verifyServiceAssertion(
            `${h}.${p}.${signature.toString('base64url')}`,
            context,
            resolver,
          )
        ).kid,
      ).toBe(kid)
    }
  })
  it('creates assertions with high-S signatures on each supported curve', async () => {
    const secp = await Secp256k1PrivateKeyExportable.createKeypair()
    for (const [signer, n] of [
      [
        key,
        BigInt(
          '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
        ),
      ],
      [
        secp,
        BigInt(
          '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
        ),
      ],
    ] as const) {
      const signingKey = {
        type: signer.type,
        jwtAlg: signer.jwtAlg,
        exportPublicKey: signer.exportPublicKey.bind(signer),
        verify: signer.verify.bind(signer),
        sign: async (input: Uint8Array) => {
          const signature = Buffer.from(await signer.sign(input))
          const s = BigInt(`0x${signature.subarray(32).toString('hex')}`)
          signature.set(
            Buffer.from(
              (s > n / 2n ? s : n - s).toString(16).padStart(64, '0'),
              'hex',
            ),
            32,
          )
          expect(await signer.verify(signature, input)).toBe(false)
          expect(
            await signer.verify(signature, input, { allowMalleableSig: true }),
          ).toBe(true)
          return signature
        },
      }
      const token = await createServiceAssertion({
        ...context,
        kid,
        signingKey,
      })
      const [h, p, s] = token.split('.')
      const signature = Buffer.from(s, 'base64url')
      expect(
        BigInt(`0x${signature.subarray(32).toString('hex')}`),
      ).toBeGreaterThan(n / 2n)
      expect(
        await signer.verify(signature, Buffer.from(`${h}.${p}`), {
          allowMalleableSig: true,
        }),
      ).toBe(true)
      expect(
        (
          await verifyServiceAssertion(token, context, {
            resolve: async () => signer,
          })
        ).kid,
      ).toBe(kid)
    }
  })

  it('requires supported header algorithms before calling a permissive resolver', async () => {
    await expect(
      verifyServiceAssertion(await changed(0, { alg: 'none' }), context, {
        resolve: async () => ({
          type: 'secp256k1',
          jwtAlg: 'none',
          verify: async () => true,
        }),
      }),
    ).rejects.toThrow()
  })

  it('requires complete JOSE signatures before calling the resolver', async () => {
    const [h, p] = assertion.split('.')
    const resolve = vi.fn(async () => ({
      type: 'p256',
      jwtAlg: 'ES256',
      verify: async () => true,
    }))
    await expect(
      verifyServiceAssertion(`${h}.${p}.AA`, context, { resolve }),
    ).rejects.toThrow()
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each([
    {
      issuer: {
        length: context.issuer.length,
        toString: () => context.issuer,
      },
    },
    { lxm: { length: context.lxm.length, toString: () => context.lxm } },
  ])('rejects coercible non-string identity inputs %j', async (changes) => {
    await expect(
      createServiceAssertion({
        ...context,
        ...changes,
        kid,
        signingKey: key,
      } as unknown as Parameters<typeof createServiceAssertion>[0]),
    ).rejects.toThrow()
  })

  it.each([{ issuer: '' }, { lxm: '' }])(
    'rejects empty identity inputs %j',
    async (changes) => {
      await expect(
        createServiceAssertion({
          ...context,
          ...changes,
          kid,
          signingKey: key,
        }),
      ).rejects.toThrow()
    },
  )
})
