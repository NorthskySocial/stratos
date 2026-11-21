import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { AtUri as AtUriSyntax } from '@atproto/syntax'
import { StratosActorStore } from '../src/context.js'
import type { ActorStore } from '../src/actor-store-types.js'
import { createCid } from './helpers/test-env.js'
import { createMockBlobStore } from './utils/index.js'
import {
  PARENT_BOUNDARY_CACHE_MAX,
  parentBoundaryCache,
  resolveParentBoundaries,
} from '../src/api/records/validation.js'
import type { AppContext } from '../src/context.js'

function replyRecord(parentUri: string): Record<string, unknown> {
  return { reply: { parent: { uri: parentUri } } }
}

const PARENT_OWNER_DIDS = [
  'did:plc:asuka',
  'did:plc:shinji',
  'did:plc:rei',
  'did:plc:misato',
]

const sqliteCleanups: Array<() => Promise<void>> = []

/**
 * A ctx over a real SQLite actor store holding one boundary-less parent record
 * per URI. Its actorStore.read is a spy on the real method, so readCount
 * counts how often resolveParentBoundaries opened the store.
 */
async function ctxWithParents(
  parentUris: string[],
): Promise<{ ctx: AppContext; readCount: () => number }> {
  const dataDir = join(
    tmpdir(),
    `stratos-test-${randomBytes(8).toString('hex')}`,
  )
  await mkdir(dataDir, { recursive: true })
  sqliteCleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  const actorStore = new StratosActorStore({
    dataDir,
    blobstore: () => createMockBlobStore(),
    cborToRecord: (content) => JSON.parse(new TextDecoder().decode(content)),
  }) as unknown as ActorStore

  for (const did of PARENT_OWNER_DIDS) {
    await actorStore.create(did)
    const ownedUris = parentUris.filter(
      (uri) => new AtUriSyntax(uri).hostname === did,
    )
    await actorStore.transact(did, async (store) => {
      for (const uri of ownedUris) {
        const value = { text: 'Unit-01 ready.' }
        const content = new TextEncoder().encode(JSON.stringify(value))
        const cid = await createCid(content)
        await store.record.putRecord({ uri, cid, value, content })
      }
    })
  }

  const read = vi.spyOn(actorStore, 'read')
  const ctx = { actorStore } as unknown as AppContext
  return { ctx, readCount: () => read.mock.calls.length }
}

describe('resolveParentBoundaries cache', () => {
  afterEach(async () => {
    parentBoundaryCache.clear()
    vi.useRealTimers()
    for (const cleanup of sqliteCleanups.splice(0)) await cleanup()
  })

  it('derives a space-record boundary without opening an authority actor store', async () => {
    const parentUri =
      'at://did:web:stratos.example/space/zone.stratos.space.feed/general/did:plc:asuka/zone.stratos.feed.post/topic-1'
    const { ctx, readCount } = await ctxWithParents([])

    await expect(
      resolveParentBoundaries(ctx, replyRecord(parentUri)),
    ).resolves.toEqual(['did:web:stratos.example/general'])
    expect(readCount()).toBe(0)
  })

  it('serves a repeat lookup for the same parent from cache within the TTL', async () => {
    const parentUri = 'at://did:plc:asuka/zone.stratos.feed.post/reply-ttl-1'
    const { ctx, readCount } = await ctxWithParents([parentUri])

    await resolveParentBoundaries(ctx, replyRecord(parentUri))
    await resolveParentBoundaries(ctx, replyRecord(parentUri))

    expect(readCount()).toBe(1)
  })

  it('deletes an expired entry rather than skipping it, forcing a re-read', async () => {
    vi.useFakeTimers()
    const expiredUri = 'at://did:plc:shinji/zone.stratos.feed.post/reply-ttl-2'
    const freshUri = 'at://did:plc:rei/zone.stratos.feed.post/reply-ttl-3'
    const { ctx, readCount } = await ctxWithParents([expiredUri, freshUri])

    await resolveParentBoundaries(ctx, replyRecord(expiredUri))
    // Advance exactly to the TTL boundary: entries this old must be treated
    // as expired (a `<=` off-by-one here would keep serving from cache).
    vi.advanceTimersByTime(60_000)
    await resolveParentBoundaries(ctx, replyRecord(freshUri))
    await resolveParentBoundaries(ctx, replyRecord(expiredUri))

    expect(readCount()).toBe(3)
    // The expired entry must be deleted and reinserted as the newest entry.
    // An overwrite in place keeps it in the oldest slot, so the size-cap
    // eviction would remove a live entry first.
    expect([...parentBoundaryCache.keys()]).toEqual([freshUri, expiredUri])
  })

  it('evicts the oldest entry once the cache exceeds its size cap', async () => {
    const firstUri = 'at://did:plc:misato/zone.stratos.feed.post/reply-cap-0'
    const otherUri = (i: number) =>
      `at://did:plc:misato/zone.stratos.feed.post/reply-cap-${i}`
    const { ctx, readCount } = await ctxWithParents(
      Array.from({ length: PARENT_BOUNDARY_CACHE_MAX + 1 }, (_, i) =>
        i === 0 ? firstUri : otherUri(i),
      ),
    )

    await resolveParentBoundaries(ctx, replyRecord(firstUri))
    expect(readCount()).toBe(1)

    // Fill up to exactly the cap (first entry + MAX-1 more) without
    // disturbing the first entry — the guard must not evict below the cap.
    for (let i = 1; i < PARENT_BOUNDARY_CACHE_MAX; i++) {
      await resolveParentBoundaries(ctx, replyRecord(otherUri(i)))
    }
    expect(readCount()).toBe(PARENT_BOUNDARY_CACHE_MAX)

    await resolveParentBoundaries(ctx, replyRecord(firstUri))
    expect(readCount()).toBe(PARENT_BOUNDARY_CACHE_MAX) // still a hit, not yet evicted

    // One more distinct entry pushes size to the cap before insert, tripping
    // the guard and evicting the oldest entry (the first URI).
    await resolveParentBoundaries(
      ctx,
      replyRecord(otherUri(PARENT_BOUNDARY_CACHE_MAX)),
    )
    expect(readCount()).toBe(PARENT_BOUNDARY_CACHE_MAX + 1)

    await resolveParentBoundaries(ctx, replyRecord(firstUri))
    expect(readCount()).toBe(PARENT_BOUNDARY_CACHE_MAX + 2) // evicted, re-fetched
  })
})
