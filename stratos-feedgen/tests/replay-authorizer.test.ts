import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSqliteDb,
  type FeedgenStore,
  migrateSqliteDb,
  SqliteFeedgenStore,
} from '../src/db/index.js'
import {
  CurrentMembershipReplayAuthorizer,
  SubscriptionIndexer,
} from '../src/subscription/index.js'
import type { ResolveEnrollmentsResult } from '../src/upstream/index.js'

const FAYE = 'did:plc:fayevalentine'
const STRATOS_DID = 'did:web:stratos.test'
const ALPHA = `${STRATOS_DID}/alpha`
const BETA = `${STRATOS_DID}/beta`
const UNCONFIGURED = `${STRATOS_DID}/unconfigured`
const POST_PATH = 'zone.stratos.feed.post/replay-test'
const URI = `at://${FAYE}/${POST_PATH}`

let store: FeedgenStore
const tmpDirs: string[] = []

async function makeStore(): Promise<FeedgenStore> {
  const dir = await mkdtemp(join(tmpdir(), 'feedgen-replay-auth-'))
  tmpDirs.push(dir)
  const db = createSqliteDb(join(dir, 'feedgen.sqlite'))
  await migrateSqliteDb(db)
  return new SqliteFeedgenStore(db)
}

function record(boundaries: string[]): Record<string, unknown> {
  return {
    $type: 'zone.stratos.feed.post',
    text: 'see you space cowboy',
    createdAt: '2024-01-01T00:00:00.000Z',
    boundary: { values: boundaries.map((value) => ({ value })) },
  }
}

function enrollment(boundaries: string[]) {
  return {
    did: FAYE,
    boundaries,
    enrolledAt: '2024-01-01T00:00:00.000Z',
    lastSeenAt: '2024-01-01T00:00:00.000Z',
  }
}

function resolution(
  boundaries: string[],
  enrolled = true,
): ResolveEnrollmentsResult {
  return { did: FAYE, enrolled, boundaries }
}

function makeIndexer(
  resolveEnrollments: (did: string) => Promise<ResolveEnrollmentsResult>,
): {
  indexer: SubscriptionIndexer
  resolveEnrollments: ReturnType<typeof vi.fn>
} {
  const resolver = vi.fn(resolveEnrollments)
  const authorizer = new CurrentMembershipReplayAuthorizer({
    store,
    client: { resolveEnrollments: resolver },
    configuredBoundaries: [ALPHA, BETA],
  })
  return {
    indexer: new SubscriptionIndexer(store, { replayAuthorizer: authorizer }),
    resolveEnrollments: resolver,
  }
}

async function applyPost(
  indexer: SubscriptionIndexer,
  seq: number,
  boundaries: string[],
  action: 'create' | 'update' = 'create',
): Promise<void> {
  await indexer.applyCommit({
    did: FAYE,
    seq,
    time: '2024-01-02T00:00:00.000Z',
    ops: [
      {
        action,
        path: POST_PATH,
        cid: `bafy${seq}`,
        record: record(boundaries),
      },
    ],
  })
}

async function seedPost(boundaries: string[]): Promise<void> {
  await store.upsertPost({
    uri: URI,
    did: FAYE,
    cid: 'bafy-existing',
    sortAt: '2024-01-01T00:00:00.000Z',
    indexedAt: '2024-01-01T00:00:00.000Z',
    record: record(boundaries),
    blobRefs: [],
    boundaries,
  })
}

beforeEach(async () => {
  store = await makeStore()
})

afterEach(async () => {
  await store.close()
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true })
  }
  tmpDirs.length = 0
})

describe('CurrentMembershipReplayAuthorizer', () => {
  it('uses a matching local snapshot after its first authoritative resolve', async () => {
    await store.upsertEnrolledActor(enrollment([ALPHA]))
    const { indexer, resolveEnrollments } = makeIndexer(async () =>
      resolution([ALPHA]),
    )

    await applyPost(indexer, 1, [ALPHA, UNCONFIGURED])
    await applyPost(indexer, 2, [ALPHA], 'update')

    expect(resolveEnrollments).toHaveBeenCalledOnce()
    expect((await store.getPost(URI))?.boundaries).toEqual([ALPHA])
    expect(await store.getCursor(FAYE)).toBe(2)
  })

  it('resolves directly when no local snapshot exists', async () => {
    const { indexer, resolveEnrollments } = makeIndexer(async () =>
      resolution([ALPHA]),
    )

    await applyPost(indexer, 1, [ALPHA])

    expect(resolveEnrollments).toHaveBeenCalledOnce()
    expect(resolveEnrollments).toHaveBeenCalledWith(FAYE)
    expect((await store.getPost(URI))?.boundaries).toEqual([ALPHA])
  })

  it('resolves directly when the local snapshot is empty', async () => {
    await store.upsertEnrolledActor(enrollment([]))
    const { indexer, resolveEnrollments } = makeIndexer(async () =>
      resolution([ALPHA]),
    )

    await applyPost(indexer, 1, [ALPHA])

    expect(resolveEnrollments).toHaveBeenCalledOnce()
    expect((await store.getPost(URI))?.boundaries).toEqual([ALPHA])
  })

  it('denies a historical alpha post after membership changed to beta', async () => {
    await seedPost([ALPHA])
    await store.upsertCursor(FAYE, 7, '2024-01-01T00:00:00.000Z')
    await store.upsertEnrolledActor(enrollment([BETA]))
    const { indexer, resolveEnrollments } = makeIndexer(async () =>
      resolution([BETA]),
    )

    await applyPost(indexer, 8, [ALPHA], 'update')

    expect(resolveEnrollments).toHaveBeenCalledOnce()
    expect(await store.getPost(URI)).toBeNull()
    expect(await store.getCursor(FAYE)).toBe(8)
  })

  it('does not trust a matching stale snapshot and retains its direct denial', async () => {
    await seedPost([ALPHA])
    await store.upsertEnrolledActor(enrollment([ALPHA]))
    const { indexer, resolveEnrollments } = makeIndexer(async () =>
      resolution([BETA]),
    )

    await applyPost(indexer, 8, [ALPHA], 'update')
    await applyPost(indexer, 9, [BETA])

    expect(resolveEnrollments).toHaveBeenCalledOnce()
    expect((await store.getPost(URI))?.boundaries).toEqual([BETA])
    expect(await store.getCursor(FAYE)).toBe(9)
  })

  it('admits a newly granted beta post after an alpha to alpha-plus-beta change', async () => {
    await store.upsertEnrolledActor(enrollment([ALPHA]))
    const { indexer, resolveEnrollments } = makeIndexer(async () =>
      resolution([ALPHA, BETA]),
    )

    await applyPost(indexer, 1, [BETA])

    expect(resolveEnrollments).toHaveBeenCalledOnce()
    expect((await store.getPost(URI))?.boundaries).toEqual([BETA])
    expect(await store.getCursor(FAYE)).toBe(1)
  })

  it('resolves again when a later local snapshot disagrees with authority', async () => {
    await store.upsertEnrolledActor(enrollment([ALPHA]))
    const resolutions = [resolution([ALPHA]), resolution([BETA])]
    const { indexer, resolveEnrollments } = makeIndexer(async () => {
      const next = resolutions.shift()
      if (!next) throw new Error('unexpected authority resolve')
      return next
    })

    await applyPost(indexer, 1, [ALPHA])
    await store.upsertEnrolledActor(enrollment([BETA]))
    await applyPost(indexer, 2, [BETA], 'update')

    expect(resolveEnrollments).toHaveBeenCalledTimes(2)
    expect((await store.getPost(URI))?.boundaries).toEqual([BETA])
  })

  it('re-resolves when an absent snapshot becomes an enrolled empty snapshot', async () => {
    const resolutions = [resolution([ALPHA]), resolution([])]
    const { indexer, resolveEnrollments } = makeIndexer(async () => {
      const next = resolutions.shift()
      if (!next) throw new Error('unexpected authority resolve')
      return next
    })

    await applyPost(indexer, 1, [ALPHA])
    await store.upsertEnrolledActor(enrollment([]))
    await applyPost(indexer, 2, [ALPHA], 'update')

    expect(resolveEnrollments).toHaveBeenCalledTimes(2)
    expect(await store.getPost(URI)).toBeNull()
    expect(await store.getCursor(FAYE)).toBe(2)
  })

  it('denies a valid unenrolled response and removes a historical post', async () => {
    await seedPost([ALPHA])
    await store.upsertEnrolledActor(enrollment([BETA]))
    const { indexer } = makeIndexer(async () => resolution([], false))

    await applyPost(indexer, 8, [ALPHA], 'update')

    expect(await store.getPost(URI)).toBeNull()
    expect(await store.getCursor(FAYE)).toBe(8)
  })

  it('throws and leaves the cursor unchanged when authority resolution fails', async () => {
    await store.upsertEnrolledActor(enrollment([BETA]))
    const { indexer } = makeIndexer(async () => {
      throw new Error('authority unavailable')
    })

    await expect(applyPost(indexer, 1, [ALPHA])).rejects.toThrow(
      'authority unavailable',
    )

    expect(await store.getPost(URI)).toBeNull()
    expect(await store.getCursor(FAYE)).toBeNull()
  })

  it('throws and leaves the cursor unchanged for a malformed authority response', async () => {
    await store.upsertEnrolledActor(enrollment([BETA]))
    const { indexer } = makeIndexer(
      async () =>
        ({
          did: FAYE,
          enrolled: true,
          boundaries: [ALPHA, 42],
        }) as unknown as ResolveEnrollmentsResult,
    )

    await expect(applyPost(indexer, 1, [ALPHA])).rejects.toMatchObject({
      code: 'ACTOR_REPLAY_AUTHORITY_INVALID',
    })

    expect(await store.getPost(URI)).toBeNull()
    expect(await store.getCursor(FAYE)).toBeNull()
  })

  it('always applies a delete op without resolving authority', async () => {
    await seedPost([ALPHA])
    await store.upsertEnrolledActor(enrollment([BETA]))
    const { indexer, resolveEnrollments } = makeIndexer(async () => {
      throw new Error('delete must not resolve authority')
    })

    await indexer.applyCommit({
      did: FAYE,
      seq: 8,
      time: '2024-01-02T00:00:00.000Z',
      ops: [{ action: 'delete', path: POST_PATH }],
    })

    expect(resolveEnrollments).not.toHaveBeenCalled()
    expect(await store.getPost(URI)).toBeNull()
    expect(await store.getCursor(FAYE)).toBe(8)
  })
})
