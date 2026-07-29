import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { decode } from '@atcute/cbor'

import { StratosActorStore } from '../src/context.js'
import { createMockBlobStore } from './utils/index.js'

const SPIKE = 'did:plc:spikespiegel'

/**
 * Store-level signing-key idempotence. The in-process signer serializes
 * concurrent first-use per DID, but separate service instances share no such
 * cache - the STORE itself must guarantee create-if-absent so two instances
 * can never persist different keys for the same actor.
 */
describe('actor store signing-key create-if-absent (SQLite backend)', () => {
  let dataDir: string
  let store: StratosActorStore

  beforeEach(async () => {
    dataDir = join(tmpdir(), `stratos-keys-${randomBytes(8).toString('hex')}`)
    await mkdir(dataDir, { recursive: true })
    store = new StratosActorStore({
      dataDir,
      blobstore: () => createMockBlobStore(),
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })
    await store.create(SPIKE)
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('a second create returns the FIRST key instead of overwriting it', async () => {
    const first = await store.createSigningKey(SPIKE)
    const second = await store.createSigningKey(SPIKE)
    expect(second.did()).toBe(first.did())
    const loaded = await store.loadSigningKey(SPIKE)
    expect(loaded?.did()).toBe(first.did())
  })

  it('concurrent creates converge on a single persisted key', async () => {
    const keys = await Promise.all(
      Array.from({ length: 5 }, () => store.createSigningKey(SPIKE)),
    )
    const dids = new Set(keys.map((k) => k.did()))
    expect(dids.size).toBe(1)
    const loaded = await store.loadSigningKey(SPIKE)
    expect(dids.has(loaded!.did())).toBe(true)
  })
})
