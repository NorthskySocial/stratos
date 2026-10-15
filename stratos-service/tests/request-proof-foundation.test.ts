import { describe, expect, it, vi } from 'vitest'
import { P256Keypair, Secp256k1Keypair, verifySignature } from '@atproto/crypto'

type PrivateKey = Parameters<typeof createRequestProof>[0]['signingKey']
import type { DidDocument } from '@atproto/identity'

import {
  createRequestProof,
  createServiceAssertion,
} from '@northskysocial/stratos-client'
import {
  admitClientRequestProof,
  admitServiceRequestProof,
  serviceAssertionKeyResolver,
  type FoundationAdmissionDeps,
} from '../src/infra/auth/request-proof-foundation.js'
import { ReplayStore } from '../src/infra/auth/replay-store.js'

const clientKey = await P256Keypair.create()
const client = {
  type: 'p256',
  jwtAlg: 'ES256',
  exportPublicKey: () => Promise.resolve(clientKey.did()),
  sign: (input: Uint8Array) => clientKey.sign(input),
  verify: (signature: Uint8Array, input: Uint8Array) =>
    verifySignature(clientKey.did(), input, signature, {
      allowMalleableSig: true,
    }),
} as unknown as PrivateKey
const request = {
  credential: 'ZXZh.bmVydg.c2hpbmpp',
  credentialKey: await client.exportPublicKey('did'),
  authority: 'did:web:nerv.tokyo.jp',
  method: 'GET',
  target: '/xrpc/zone.stratos.space.getRecord?a=%2F&a=rei?',
  body: new Uint8Array(),
  now: 1000,
}
const proof = await createRequestProof({ ...request, signingKey: client })
const issuer = 'did:web:rei.nerv.jp'
const kid = `${issuer}#atproto`
const lxm = 'zone.stratos.space.getRecord'
const assertion = await createServiceAssertion({
  proof,
  request,
  issuer,
  lxm,
  kid,
  signingKey: client,
})
const presentation = { credential: request.credential, proof, assertion }
const policy = { issuer, lxm, resolver: { resolve: async () => client } }
function dependencies() {
  const seen = new Set<string>()
  const setNxEx = vi.fn(async (key: string) => {
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const consumeOnce = vi.fn(
    new ReplayStore({ setNxEx }).consumeOnce.bind(new ReplayStore({ setNxEx })),
  )
  const deps: FoundationAdmissionDeps = {
    request,
    verifyCredential: vi.fn(async () => ({
      credentialKey: request.credentialKey,
    })),
    authorize: vi.fn(async () => true),
    replayStore: { consumeOnce },
    nowSeconds: () => 1000.25,
  }
  return { deps, consumeOnce, setNxEx }
}

describe('injected proof admission foundation', () => {
  it('consumes one identity after complete verification and authorization', async () => {
    const { deps, consumeOnce } = dependencies()
    const order: string[] = []
    deps.verifyCredential = async (token) => {
      expect(token).toBe(request.credential)
      order.push('credential')
      return { credentialKey: request.credentialKey }
    }
    deps.authorize = async (verified, service) => {
      expect(verified.claims.target).toBe(request.target)
      expect(service).toEqual({ issuer, kid })
      expect(consumeOnce).not.toHaveBeenCalled()
      order.push('authorize')
      return true
    }
    const verified = await admitServiceRequestProof(presentation, deps, policy)
    expect(order).toEqual(['credential', 'authorize'])
    expect(consumeOnce).toHaveBeenCalledExactlyOnceWith(
      'stratos-request-proof-v1',
      verified.replayId,
      65,
    )
  })

  it('admits at most one concurrent duplicate in retained seam state and allows a fresh retry', async () => {
    const { deps, consumeOnce } = dependencies()
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        admitServiceRequestProof(presentation, deps, policy),
      ),
    )
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1)
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(9)
    expect(consumeOnce).toHaveBeenCalledTimes(10)
    const next = await createRequestProof({ ...request, signingKey: client })
    const nextAssertion = await createServiceAssertion({
      proof: next,
      request,
      issuer,
      lxm,
      kid,
      signingKey: client,
    })
    await expect(
      admitServiceRequestProof(
        { ...presentation, proof: next, assertion: nextAssertion },
        deps,
        policy,
      ),
    ).resolves.toBeDefined()
  })

  it.each([
    'credential',
    'client',
    'assertion',
    'service',
    'authorization',
    'expiry',
  ])('does not burn proof IDs on %s failure', async (failure) => {
    const { deps, consumeOnce } = dependencies()
    let input = presentation
    let servicePolicy = policy
    if (failure === 'credential')
      deps.verifyCredential = async () => {
        throw new Error('invalid credential')
      }
    if (failure === 'client')
      deps.verifyCredential = async () => ({
        credentialKey: `${request.credentialKey}wrong`,
      })
    if (failure === 'assertion')
      input = { ...presentation, assertion: `${assertion}x` }
    if (failure === 'service')
      servicePolicy = {
        ...policy,
        resolver: {
          resolve: async () => {
            throw new Error('untrusted')
          },
        },
      }
    if (failure === 'authorization') deps.authorize = async () => false
    if (failure === 'expiry')
      deps.authorize = async () => {
        deps.nowSeconds = () => 1065
        return true
      }
    await expect(
      admitServiceRequestProof(input, deps, servicePolicy),
    ).rejects.toThrow()
    expect(consumeOnce).not.toHaveBeenCalled()
    const retry = dependencies()
    await expect(
      admitServiceRequestProof(
        presentation,
        { ...retry.deps, replayStore: deps.replayStore },
        policy,
      ),
    ).resolves.toBeDefined()
    expect(consumeOnce).toHaveBeenCalledTimes(1)
  })

  it('never downgrades required identity or ignores unsolicited identity', async () => {
    const { deps, consumeOnce } = dependencies()
    const clientOnly = { credential: request.credential, proof }
    await expect(
      admitServiceRequestProof(clientOnly, deps, policy),
    ).rejects.toThrow('Authorization failed')
    await expect(admitClientRequestProof(presentation, deps)).rejects.toThrow(
      'Authorization failed',
    )
    expect(consumeOnce).not.toHaveBeenCalled()
    await expect(
      admitClientRequestProof(clientOnly, deps),
    ).resolves.toBeDefined()
  })

  it('rejects denied authorization with a generic error before replay consumption', async () => {
    const { deps, consumeOnce } = dependencies()
    deps.authorize = vi.fn(async () => false)
    await expect(
      admitServiceRequestProof(presentation, deps, policy),
    ).rejects.toThrow('Authorization failed')
    expect(consumeOnce).not.toHaveBeenCalled()
  })

  it.each([undefined, false])(
    'rejects missing or duplicate replay state (%s) with a generic error',
    async (result) => {
      const { deps } = dependencies()
      deps.replayStore =
        result === undefined ? undefined : { consumeOnce: async () => result }
      await expect(
        admitServiceRequestProof(presentation, deps, policy),
      ).rejects.toThrow('Authorization failed')
    },
  )

  it('fails closed on missing, false or rejecting replay storage', async () => {
    for (const replayStore of [
      undefined,
      { consumeOnce: async () => false },
      {
        consumeOnce: async () => {
          throw new Error('unavailable')
        },
      },
    ]) {
      const { deps } = dependencies()
      await expect(
        admitServiceRequestProof(
          presentation,
          { ...deps, replayStore },
          policy,
        ),
      ).rejects.toThrow()
    }
  })
})

describe('published service DID key selection', () => {
  it.each([P256Keypair, Secp256k1Keypair])(
    'uses published matching material and fresh resolution',
    async (Keypair) => {
      const key = await Keypair.create()
      let document: DidDocument = {
        id: issuer,
        verificationMethod: [
          {
            id: kid,
            controller: issuer,
            type: 'Multikey',
            publicKeyMultibase: key.did().slice('did:key:'.length),
          },
        ],
      }
      const resolve = vi.fn(async () => document)
      const resolver = serviceAssertionKeyResolver({ resolve })
      const selected = await resolver.resolve(issuer, kid)
      const input = new TextEncoder().encode('nerv')
      expect(await selected.verify(await key.sign(input), input)).toBe(true)
      expect(selected.jwtAlg).toBe(key.jwtAlg)
      expect(selected.type).toBe(key.jwtAlg === 'ES256' ? 'p256' : 'secp256k1')
      const order = BigInt(
        key.jwtAlg === 'ES256'
          ? '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'
          : '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
      )
      const signature = await key.sign(input)
      const s = BigInt(`0x${Buffer.from(signature.slice(32)).toString('hex')}`)
      const highS = s > order / 2n ? s : order - s
      const highSignature = new Uint8Array(signature)
      highSignature.set(
        Buffer.from(highS.toString(16).padStart(64, '0'), 'hex'),
        32,
      )
      expect(await selected.verify(highSignature, input)).toBe(true)
      expect(
        await selected.verify(highSignature, new TextEncoder().encode('seele')),
      ).toBe(false)
      expect(resolve).toHaveBeenCalledExactlyOnceWith(issuer, true)
      document = { id: issuer, verificationMethod: [] }
      await expect(resolver.resolve(issuer, kid)).rejects.toThrow()
    },
  )

  it.each(['z6MkiTBz1ymuepKkWfqAXbP8BvTAg8nNUTVQCR7s1zJrDJs6', 'zInvalid'])(
    'rejects unsupported or malformed multikey material %s',
    async (publicKeyMultibase) => {
      const resolve = async (): Promise<DidDocument> => ({
        id: issuer,
        verificationMethod: [
          { id: kid, controller: issuer, type: 'Multikey', publicKeyMultibase },
        ],
      })
      await expect(
        serviceAssertionKeyResolver({ resolve }).resolve(issuer, kid),
      ).rejects.toThrow()
    },
  )

  it('rejects wrong document, controller, duplicate ID, missing key and resolver outage', async () => {
    const key = await P256Keypair.create()
    const method = {
      id: kid,
      controller: issuer,
      type: 'Multikey',
      publicKeyMultibase: key.did().slice(8),
    }
    for (const document of [
      null,
      { id: issuer },
      { id: 'did:web:seele.jp', verificationMethod: [method] },
      {
        id: issuer,
        verificationMethod: [{ ...method, controller: 'did:web:seele.jp' }],
      },
      { id: issuer, verificationMethod: [method, method] },
      {
        id: issuer,
        verificationMethod: [{ ...method, id: `${issuer}#other` }],
      },
      {
        id: issuer,
        verificationMethod: [{ ...method, publicKeyMultibase: undefined }],
      },
      { id: issuer, verificationMethod: [{ ...method, type: 'Unknown' }] },
    ])
      await expect(
        serviceAssertionKeyResolver({ resolve: async () => document }).resolve(
          issuer,
          kid,
        ),
      ).rejects.toThrow('Authorization failed')
    await expect(
      serviceAssertionKeyResolver({
        resolve: async () => {
          throw new Error('unavailable')
        },
      }).resolve(issuer, kid),
    ).rejects.toThrow()
  })
})
