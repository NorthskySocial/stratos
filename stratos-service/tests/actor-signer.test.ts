import { describe, expect, it, vi } from 'vitest'
import type { Keypair } from '@atproto/crypto'
import type { ActorStore } from '../src/actor-store-types.js'
import { InProcessActorSigner } from '../src/infra/signing/actor-signer.js'

const SPIKE = 'did:plc:spikespiegel'

function makeKeypair(name: string): Keypair {
  return {
    did: () => `did:key:${name}`,
    sign: vi.fn(async () => new Uint8Array([1])),
  } as unknown as Keypair
}

/**
 * Minimal ActorStore stub for the signer: only the two key-store methods the
 * signer is allowed to call are provided.
 */
function makeStore(opts: {
  load: (did: string) => Promise<Keypair | null>
  create: (did: string) => Promise<Keypair>
}): ActorStore {
  return {
    loadSigningKey: vi.fn(opts.load),
    createSigningKey: vi.fn(opts.create),
  } as unknown as ActorStore
}

describe('InProcessActorSigner', () => {
  it('serializes concurrent first-use so all callers get the SAME key', async () => {
    // Neither backend makes creation idempotent - each create call would mint
    // a fresh key. Gate the first load so both callers arrive before any
    // create resolves, exactly the race that could persist two keys.
    let releaseLoad: () => void = () => {}
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    let created = 0
    const store = makeStore({
      load: async () => {
        await loadGate
        return null
      },
      create: async () => {
        created += 1
        return makeKeypair(`minted-${created}`)
      },
    })
    const signer = new InProcessActorSigner(store)

    const p1 = signer.getPublicKey(SPIKE)
    const p2 = signer.getPublicKey(SPIKE)
    releaseLoad()
    const [k1, k2] = await Promise.all([p1, p2])

    expect(k1).toBe(k2)
    expect(created).toBe(1)
    expect(store.loadSigningKey).toHaveBeenCalledTimes(1)
    expect(store.createSigningKey).toHaveBeenCalledTimes(1)
  })

  it('releases the in-flight slot after a failure so retries work', async () => {
    let attempt = 0
    const store = makeStore({
      load: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('store down')
        return makeKeypair('stable')
      },
      create: async () => makeKeypair('never'),
    })
    const signer = new InProcessActorSigner(store)

    await expect(signer.getPublicKey(SPIKE)).rejects.toThrow('store down')
    expect(await signer.getPublicKey(SPIKE)).toBe('did:key:stable')
  })

  it('serves subsequent calls from the TTL cache without re-loading', async () => {
    const store = makeStore({
      load: async () => makeKeypair('cached'),
      create: async () => makeKeypair('never'),
    })
    const signer = new InProcessActorSigner(store)

    expect(await signer.getPublicKey(SPIKE)).toBe('did:key:cached')
    expect(await signer.getPublicKey(SPIKE)).toBe('did:key:cached')
    await signer.ensureKey(SPIKE)
    expect(store.loadSigningKey).toHaveBeenCalledTimes(1)
  })
})
