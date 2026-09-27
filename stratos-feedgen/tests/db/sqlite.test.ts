import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { loadFeedgenConfig } from '../../src/config.js'
import {
  createFeedgenStore,
  createSqliteDb,
  migrateSqliteDb,
  SqliteFeedgenStore,
} from '../../src/db/index.js'
import { describeStoreContract } from './contract.js'

const tempDirs: string[] = []
const SQLITE_HEADER = Buffer.from('SQLite format 3\0')

async function makeTempDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'feedgen-sqlite-'))
  tempDirs.push(dir)
  return join(dir, 'feedgen.sqlite')
}

function sqliteConfig(recordPath: string, membershipPath: string) {
  return loadFeedgenConfig({
    FEEDGEN_SERVICE_DID: 'did:web:feedgen.bebop.test',
    FEEDGEN_SIGNING_KEY: 'unused-by-this-test',
    STRATOS_SERVICE_URL: 'https://stratos.bebop.test',
    STRATOS_SERVICE_DID: 'did:web:stratos.bebop.test',
    FEEDGEN_STORAGE_PROFILE: 'encrypted-volume',
    FEEDGEN_SQLITE_PATH: recordPath,
    FEEDGEN_MEMBERSHIP_SQLITE_PATH: membershipPath,
    FEEDGEN_BLOB_CACHE_DIRECTORY: `${recordPath}.blobs`,
    FEEDGEN_PROJECTION_MAX_AGE_MS: '3600000',
    FEEDGEN_PROJECTION_MAX_BYTES: '536870912',
  })
}

function inMemorySqliteConfig(membershipPath: string) {
  return loadFeedgenConfig({
    FEEDGEN_SERVICE_DID: 'did:web:feedgen.bebop.test',
    FEEDGEN_SIGNING_KEY: 'unused-by-this-test',
    STRATOS_SERVICE_URL: 'https://stratos.bebop.test',
    STRATOS_SERVICE_DID: 'did:web:stratos.bebop.test',
    FEEDGEN_MEMBERSHIP_SQLITE_PATH: membershipPath,
  })
}

async function listSqliteArtifacts(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const artifacts = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        if (entry.name.endsWith('-journal') || entry.name.endsWith('-shm')) {
          return entry.name
        }
        if (entry.name.endsWith('-wal')) return entry.name
        const header = await readFile(join(directory, entry.name), {
          encoding: null,
          flag: 'r',
        })
        return header.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)
          ? entry.name
          : undefined
      }),
  )
  return artifacts.filter((name): name is string => name !== undefined).sort()
}

describeStoreContract('sqlite', {
  async build() {
    const db = createSqliteDb(':memory:')
    await migrateSqliteDb(db)
    return new SqliteFeedgenStore(db)
  },
})

describe('SQLite-specific behavior', () => {
  afterAll(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('uses memory journal mode for an in-memory database', async () => {
    const db = createSqliteDb(':memory:')
    const store = new SqliteFeedgenStore(db)
    try {
      await db._initialized
      const result = await db.get<{ journal_mode: string }>(
        sql`PRAGMA journal_mode`,
      )
      expect(result?.journal_mode).toBe('memory')
    } finally {
      await store.close()
    }
  })

  it('creates no filesystem artifact for the generated in-memory URI', async () => {
    const before = await listSqliteArtifacts(process.cwd())
    const db = createSqliteDb(':memory:')
    const store = new SqliteFeedgenStore(db)
    try {
      await migrateSqliteDb(db)
      await store.upsertCursor(
        'did:plc:millythompson',
        3,
        '2024-01-01T00:00:00.000Z',
      )
    } finally {
      await store.close()
    }
    expect(await listSqliteArtifacts(process.cwd())).toEqual(before)
  })

  it('keeps separate in-memory clients isolated', async () => {
    const firstDb = createSqliteDb(':memory:')
    const secondDb = createSqliteDb(':memory:')
    await migrateSqliteDb(firstDb)
    await migrateSqliteDb(secondDb)
    const first = new SqliteFeedgenStore(firstDb)
    const second = new SqliteFeedgenStore(secondDb)

    try {
      await first.upsertCursor(
        'did:plc:fayevalentine',
        7,
        '2024-01-01T00:00:00.000Z',
      )
      expect(await first.getCursor('did:plc:fayevalentine')).toBe(7)
      expect(await second.getCursor('did:plc:fayevalentine')).toBeNull()
    } finally {
      await first.close()
      await second.close()
    }
  })

  it('excludes expired posts before compaction and removes them incrementally', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z')
    const db = createSqliteDb(':memory:')
    await migrateSqliteDb(db)
    const store = new SqliteFeedgenStore(db, db, {
      maxAgeMs: 1_000,
      maxBytes: 10_000,
      now: () => now,
    })
    try {
      const post = {
        uri: 'at://did:plc:kaorunagisa/zone.stratos.feed.post/1',
        did: 'did:plc:kaorunagisa',
        cid: 'bafyreigh2akiscaildc',
        sortAt: '2026-01-01T00:00:00.000Z',
        indexedAt: '2026-01-01T00:00:00.000Z',
        record: { text: 'The song is complete.' },
        blobRefs: [],
        boundaries: ['nerv'],
      }
      await store.upsertPost(post)
      now += 1_000
      expect(await store.getPost(post.uri)).toBeNull()
      expect(
        await store.listPostsByBoundary({ boundary: 'nerv', limit: 10 }),
      ).toEqual({ posts: [] })
      expect((await store.compactProjection()).posts).toBe(1)
      expect(await store.compactProjection()).toMatchObject({ posts: 0 })
    } finally {
      await store.close()
    }
  })

  it('evicts the oldest retained post when the projection byte budget is exceeded', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z')
    const db = createSqliteDb(':memory:')
    await migrateSqliteDb(db)
    const store = new SqliteFeedgenStore(db, db, {
      maxAgeMs: 60_000,
      maxBytes: 350,
      now: () => now,
    })
    try {
      const first = {
        uri: 'at://did:plc:misatokatsuragi/zone.stratos.feed.post/1',
        did: 'did:plc:misatokatsuragi',
        cid: 'bafyreigh2akiscaildc',
        sortAt: '2026-01-01T00:00:00.000Z',
        indexedAt: '2026-01-01T00:00:00.000Z',
        record: { text: 'A'.repeat(100) },
        blobRefs: [],
        boundaries: ['nerv'],
      }
      await store.upsertPost(first)
      now += 1
      const second = {
        ...first,
        uri: `${first.uri}-new`,
        sortAt: '2026-01-01T00:01:00.000Z',
      }
      await store.upsertPost(second)
      expect(await store.getPost(first.uri)).toBeNull()
      expect(await store.getPost(second.uri)).not.toBeNull()
    } finally {
      await store.close()
    }
  })

  it('queues a shared blob cache key only after its final post reference is removed', async () => {
    const db = createSqliteDb(':memory:')
    await migrateSqliteDb(db)
    const store = new SqliteFeedgenStore(db, db, {
      maxAgeMs: 60_000,
      maxBytes: 10_000,
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    })
    const sharedBlob =
      'bafybeigdyrzt5l3r2f4pbfxz7o4jqm3t4l2mghz5bcptv7xkz4teb5p5ba'
    const firstUri = 'at://did:plc:misatokatsuragi/zone.stratos.feed.post/1'
    try {
      for (const uri of [firstUri, `${firstUri}-second`]) {
        await store.upsertPost({
          uri,
          did: 'did:plc:misatokatsuragi',
          cid: `cid-${uri}`,
          sortAt: '2026-01-01T00:00:00.000Z',
          indexedAt: '2026-01-01T00:00:00.000Z',
          record: { text: 'You are late.' },
          blobRefs: [{ cid: sharedBlob }],
          boundaries: ['nerv'],
        })
      }
      await store.deletePost(firstUri)
      expect((await store.compactProjection()).blobCacheEntries).toBe(0)

      await store.deletePost(`${firstUri}-second`)
      const pending = await store.compactProjection()
      expect(pending.blobCacheEntries).toBe(1)
      expect(pending.blobCacheKeys).toHaveLength(1)
    } finally {
      await store.close()
    }
  })

  it('drains cache eviction work without enabling durable projection retention', async () => {
    const db = createSqliteDb(':memory:')
    await migrateSqliteDb(db)
    const store = new SqliteFeedgenStore(db)
    try {
      const post = {
        uri: 'at://did:plc:misatokatsuragi/zone.stratos.feed.post/ephemeral',
        did: 'did:plc:misatokatsuragi',
        cid: 'bafyreigh2akiscaildc',
        sortAt: '2026-01-01T00:00:00.000Z',
        indexedAt: '2026-01-01T00:00:00.000Z',
        record: { text: 'You are late.' },
        blobRefs: [
          {
            cid: 'bafybeigdyrzt5l3r2f4pbfxz7o4jqm3t4l2mghz5bcptv7xkz4teb5p5ba',
          },
        ],
        boundaries: ['nerv'],
      }
      await store.upsertPost(post)
      await store.deletePost(post.uri)
      const pending = await store.compactProjection()
      expect(pending).toMatchObject({ posts: 0, blobCacheEntries: 1 })
      await store.completeBlobCacheEvictions(pending.blobCacheKeys)
      expect((await store.compactProjection()).blobCacheEntries).toBe(0)
    } finally {
      await store.close()
    }
  })

  it('compacts an expired durable projection after a restart', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z')
    const path = await makeTempDbPath()
    const firstDb = createSqliteDb(path)
    await migrateSqliteDb(firstDb)
    const firstStore = new SqliteFeedgenStore(firstDb, firstDb, {
      maxAgeMs: 1_000,
      maxBytes: 10_000,
      now: () => now,
    })
    await firstStore.upsertPost({
      uri: 'at://did:plc:reiayanami/zone.stratos.feed.post/1',
      did: 'did:plc:reiayanami',
      cid: 'bafyreigh2akiscaildc',
      sortAt: '2026-01-01T00:00:00.000Z',
      indexedAt: '2026-01-01T00:00:00.000Z',
      record: { text: 'I am here.' },
      blobRefs: [
        { cid: 'bafybeigdyrzt5l3r2f4pbfxz7o4jqm3t4l2mghz5bcptv7xkz4teb5p5ba' },
      ],
      boundaries: ['nerv'],
    })
    await firstStore.close()

    now += 1_000
    const restartedDb = createSqliteDb(path)
    await migrateSqliteDb(restartedDb)
    const restartedStore = new SqliteFeedgenStore(restartedDb, restartedDb, {
      maxAgeMs: 1_000,
      maxBytes: 10_000,
      now: () => now,
    })
    let restartedClosed = false
    try {
      expect(
        await restartedStore.listPostsByBoundary({
          boundary: 'nerv',
          limit: 10,
        }),
      ).toEqual({ posts: [] })
      const firstPass = await restartedStore.compactProjection()
      expect(firstPass.posts).toBe(1)
      expect(firstPass.blobCacheEntries).toBe(1)
      expect(firstPass.blobCacheKeys).toHaveLength(1)
      await restartedStore.close()
      restartedClosed = true

      const finalDb = createSqliteDb(path)
      await migrateSqliteDb(finalDb)
      const finalStore = new SqliteFeedgenStore(finalDb, finalDb, {
        maxAgeMs: 1_000,
        maxBytes: 10_000,
        now: () => now,
      })
      try {
        const resumed = await finalStore.compactProjection()
        expect(resumed.posts).toBe(0)
        expect(resumed.blobCacheKeys).toEqual(firstPass.blobCacheKeys)
        await finalStore.completeBlobCacheEvictions(resumed.blobCacheKeys)
        expect((await finalStore.compactProjection()).blobCacheEntries).toBe(0)
      } finally {
        await finalStore.close()
      }
    } finally {
      if (!restartedClosed) await restartedStore.close()
    }
  })

  it('compacts stale cursors and unverified staging without an unbounded scan', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z')
    const db = createSqliteDb(':memory:')
    await migrateSqliteDb(db)
    const store = new SqliteFeedgenStore(db, db, {
      maxAgeMs: 1_000,
      maxBytes: 10_000,
      batchSize: 1,
      now: () => now,
    })
    try {
      await store.upsertCursor(
        'did:plc:asukanoryu',
        1,
        '2026-01-01T00:00:00.000Z',
      )
      await store.upsertSpaceCursor(
        'at://did:plc:nerv/space/zone.stratos.feed/post/did:plc:asukanoryu',
        'did:plc:asukanoryu',
        'next',
        '2026-01-01T00:00:00.000Z',
      )
      await store.stageSpaceSyncPage({
        spaceUri:
          'at://did:plc:nerv/space/zone.stratos.feed/post/did:plc:asukanoryu',
        did: 'did:plc:asukanoryu',
        boundary: 'nerv',
        mutations: [
          {
            kind: 'upsert',
            post: {
              uri: 'at://did:plc:asukanoryu/zone.stratos.feed.post/1',
              did: 'did:plc:asukanoryu',
              cid: 'bafyreigh2akiscaildc',
              sortAt: '2026-01-01T00:00:00.000Z',
              indexedAt: '2026-01-01T00:00:00.000Z',
              record: { text: 'I am not a doll.' },
              blobRefs: [],
              boundaries: ['nerv'],
            },
          },
        ],
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
      now += 1_000
      const first = await store.compactProjection()
      expect(first).toMatchObject({
        syncCursors: 1,
        spaceCursors: 1,
        stagedRecords: 1,
        pendingVerifications: 1,
      })
      expect(first.hasMore).toBe(false)
      expect(await store.getCursor('did:plc:asukanoryu')).toBeNull()
      expect(
        await store.getSpaceCursor(
          'at://did:plc:nerv/space/zone.stratos.feed/post/did:plc:asukanoryu',
          'did:plc:asukanoryu',
        ),
      ).toBeNull()
    } finally {
      await store.close()
    }
  })

  it('keeps an in-memory schema after a transaction releases its connection', async () => {
    const db = createSqliteDb(':memory:')
    await migrateSqliteDb(db)
    const store = new SqliteFeedgenStore(db)

    try {
      await store.upsertPost({
        uri: 'at://did:plc:motokokusanagi/zone.stratos.feed.post/1',
        did: 'did:plc:motokokusanagi',
        cid: 'bafyreigh2akiscaildc',
        sortAt: '2024-01-01T00:00:00.000Z',
        indexedAt: '2024-01-01T00:00:00.000Z',
        record: { $type: 'zone.stratos.feed.post' },
        blobRefs: [],
        boundaries: ['engineering'],
      })

      expect(
        await store.getSpaceCursor(
          'at://did:web:example.test/space/zone.stratos.space.feed/engineering',
          'did:plc:motokokusanagi',
        ),
      ).toBeNull()
    } finally {
      await store.close()
    }
  })

  it('opens file databases in WAL mode', async () => {
    const dbPath = await makeTempDbPath()
    const db = createSqliteDb(dbPath)
    await db._initialized
    const result = await db.get<{ journal_mode: string }>(
      sql`PRAGMA journal_mode`,
    )
    expect(result?.journal_mode).toBe('wal')
    db._client.close()
  })

  it('rejects an existing durable database file that is readable by other users', async () => {
    const recordPath = await makeTempDbPath()
    const membershipPath = await makeTempDbPath()
    await writeFile(recordPath, '')
    await chmod(recordPath, 0o644)
    await expect(
      createFeedgenStore(sqliteConfig(recordPath, membershipPath)),
    ).rejects.toThrow(/SQLite storage file must be private/)
  })

  it('rejects an existing SQLite sidecar that is readable by other users', async () => {
    const recordPath = await makeTempDbPath()
    const membershipPath = await makeTempDbPath()
    await writeFile(`${recordPath}-wal`, '')
    await chmod(`${recordPath}-wal`, 0o644)
    await expect(
      createFeedgenStore(sqliteConfig(recordPath, membershipPath)),
    ).rejects.toThrow(/SQLite storage file must be private/)
  })

  it('rejects a durable database path below a non-private directory', async () => {
    const recordPath = join(tmpdir(), 'feedgen-public-records.sqlite')
    const membershipPath = join(tmpdir(), 'feedgen-public-membership.sqlite')
    await expect(
      createFeedgenStore(sqliteConfig(recordPath, membershipPath)),
    ).rejects.toThrow(/SQLite storage directory must be private/)
  })

  it('creates durable database files with private permissions', async () => {
    const recordPath = await makeTempDbPath()
    const membershipPath = await makeTempDbPath()
    const store = await createFeedgenStore(
      sqliteConfig(recordPath, membershipPath),
    )
    try {
      expect((await stat(recordPath)).mode & 0o077).toBe(0)
      expect((await stat(membershipPath)).mode & 0o077).toBe(0)
    } finally {
      await store.close()
    }
  })

  it('migration is idempotent', async () => {
    const dbPath = await makeTempDbPath()
    const db = createSqliteDb(dbPath)
    await migrateSqliteDb(db)
    await migrateSqliteDb(db)
    await migrateSqliteDb(db)
    const store = new SqliteFeedgenStore(db)
    await store.upsertCursor(
      'did:plc:idempotent',
      1,
      '2024-01-01T00:00:00.000Z',
    )
    expect(await store.getCursor('did:plc:idempotent')).toBe(1)
    await store.close()
  })

  it('resets the in-memory record projection but keeps membership snapshots', async () => {
    const membershipPath = await makeTempDbPath()
    const did = 'did:plc:spikespiegel'
    const spaceUri = `at://${did}/zone.stratos.space/bebop`
    const indexedAt = '2024-01-01T00:00:00.000Z'
    const postUri = `at://${did}/zone.stratos.feed.post/1`
    const firstStore = await createFeedgenStore(
      inMemorySqliteConfig(membershipPath),
    )

    await firstStore.upsertPost({
      uri: postUri,
      did,
      cid: 'bafyrecord',
      sortAt: indexedAt,
      indexedAt,
      record: { text: 'See you, space cowboy.' },
      blobRefs: [],
      boundaries: ['bounty-hunters'],
    })
    await firstStore.upsertCursor(did, 42, indexedAt)
    await firstStore.upsertSpaceCursor(spaceUri, did, 'cursor-42', indexedAt)
    await firstStore.upsertEnrolledActor({
      did,
      boundaries: ['bounty-hunters'],
      enrolledAt: indexedAt,
      lastSeenAt: indexedAt,
    })
    await firstStore.replaceSpaceMembers('bounty-hunters', [
      { did, custody: 'pds', host: 'https://bebop.example' },
    ])
    await firstStore.close()

    const restartedStore = await createFeedgenStore(
      inMemorySqliteConfig(membershipPath),
    )
    try {
      expect(await restartedStore.getPost(postUri)).toBeNull()
      expect(await restartedStore.getCursor(did)).toBeNull()
      expect(await restartedStore.getSpaceCursor(spaceUri, did)).toBeNull()
      expect(await restartedStore.getEnrolledActor(did)).toEqual({
        did,
        boundaries: ['bounty-hunters'],
        enrolledAt: indexedAt,
        lastSeenAt: indexedAt,
      })
      expect(await restartedStore.listSpaceMembers('bounty-hunters')).toEqual([
        { did, custody: 'pds', host: 'https://bebop.example' },
      ])
    } finally {
      await restartedStore.close()
    }
  })

  it('persists only membership snapshots when the record store resets', async () => {
    const recordPath = await makeTempDbPath()
    const membershipPath = await makeTempDbPath()
    const firstStore = await createFeedgenStore(
      sqliteConfig(recordPath, membershipPath),
    )
    const did = 'did:plc:spikespiegel'
    const spaceUri = `at://${did}/zone.stratos.space/bebop`
    const indexedAt = '2024-01-01T00:00:00.000Z'

    await firstStore.upsertPost({
      uri: `at://${did}/zone.stratos.feed.post/1`,
      did,
      cid: 'bafyrecord',
      sortAt: indexedAt,
      indexedAt,
      record: { text: 'See you, space cowboy.' },
      blobRefs: [],
      boundaries: ['bounty-hunters'],
    })
    await firstStore.upsertCursor(did, 42, indexedAt)
    await firstStore.upsertSpaceCursor(spaceUri, did, 'cursor-42', indexedAt)
    await firstStore.upsertEnrolledActor({
      did,
      boundaries: ['bounty-hunters'],
      enrolledAt: indexedAt,
      lastSeenAt: indexedAt,
    })
    await firstStore.replaceSpaceMembers('bounty-hunters', [
      { did, custody: 'pds', host: 'https://bebop.example' },
    ])
    await firstStore.close()

    await Promise.all([
      rm(recordPath, { force: true }),
      rm(`${recordPath}-shm`, { force: true }),
      rm(`${recordPath}-wal`, { force: true }),
    ])
    const restartedStore = await createFeedgenStore(
      sqliteConfig(recordPath, membershipPath),
    )

    expect(
      await restartedStore.getPost(`at://${did}/zone.stratos.feed.post/1`),
    ).toBeNull()
    expect(await restartedStore.getCursor(did)).toBeNull()
    expect(await restartedStore.getSpaceCursor(spaceUri, did)).toBeNull()
    expect(await restartedStore.getEnrolledActor(did)).toEqual({
      did,
      boundaries: ['bounty-hunters'],
      enrolledAt: indexedAt,
      lastSeenAt: indexedAt,
    })
    expect(await restartedStore.listSpaceMembers('bounty-hunters')).toEqual([
      { did, custody: 'pds', host: 'https://bebop.example' },
    ])
    await restartedStore.close()
  })

  it('keeps unverified space sync state in the record database', async () => {
    const recordPath = await makeTempDbPath()
    const membershipPath = await makeTempDbPath()
    const store = await createFeedgenStore(
      sqliteConfig(recordPath, membershipPath),
    )
    const did = 'did:plc:spikespiegel'
    const spaceUri = `at://${did}/zone.stratos.space/bebop`
    const postUri = `at://${did}/zone.stratos.feed.post/staged`
    const indexedAt = '2024-01-01T00:00:00.000Z'

    try {
      await store.stageSpaceSyncPage({
        spaceUri,
        did,
        boundary: 'bounty-hunters',
        mutations: [{ kind: 'delete', uri: postUri }],
        nextCursor: 'cursor-1',
        updatedAt: indexedAt,
      })
      await store.stageSpaceSyncPage({
        spaceUri,
        did,
        boundary: 'bounty-hunters',
        mutations: [],
        updatedAt: indexedAt,
      })

      expect(await store.getSpaceCursor(spaceUri, did)).toBe('cursor-1')
    } finally {
      await store.close()
    }

    const recordDb = createSqliteDb(recordPath)
    const membershipDb = createSqliteDb(membershipPath)
    try {
      expect(
        await recordDb.all<{ uri: string }>(sql`
          SELECT uri
          FROM space_sync_stage
        `),
      ).toEqual([{ uri: postUri }])
      expect(
        await recordDb.all<{ did: string }>(sql`
          SELECT did
          FROM space_sync_pending_verification
        `),
      ).toEqual([{ did }])
      expect(
        await membershipDb.all<{ name: string }>(sql`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name IN (
              'space_sync_cursor',
              'space_sync_pending_verification',
              'space_sync_stage'
            )
        `),
      ).toEqual([])
    } finally {
      recordDb._client.close()
      membershipDb._client.close()
    }
  })

  it('serializes concurrent space-member staging and reset transactions', async () => {
    const db = createSqliteDb(':memory:')
    await migrateSqliteDb(db)
    const store = new SqliteFeedgenStore(db)
    const authorityDid = 'did:web:stratos.bebop.test'
    const spaceUri = `at://${authorityDid}/space/zone.stratos.space.feed/bounty-hunters`
    const members = [
      'did:plc:spikespiegel',
      'did:plc:fayevalentine',
      'did:plc:jetblack',
      'did:plc:edwardwong',
      'did:plc:vicious',
    ]
    const indexedAt = '2024-01-01T00:00:00.000Z'

    try {
      await Promise.all(
        members.map((did, index) =>
          store.stageSpaceSyncPage({
            spaceUri,
            did,
            boundary: 'bounty-hunters',
            mutations: [
              {
                kind: 'upsert',
                post: {
                  uri: `${spaceUri}/${did}/zone.stratos.feed.post/${index}`,
                  did,
                  cid: `bafyspace${index}`,
                  sortAt: indexedAt,
                  indexedAt,
                  record: { text: `Space sync ${index}` },
                  blobRefs: [],
                  boundaries: [],
                },
              },
            ],
            updatedAt: indexedAt,
          }),
        ),
      )

      await Promise.all(
        members.map((did) => store.promoteSpaceSyncStage(spaceUri, did)),
      )

      const posts = await store.listPostsByBoundary({
        boundary: 'bounty-hunters',
        limit: members.length,
      })
      expect(posts.posts.map((post) => post.did).sort()).toEqual(
        members.slice().sort(),
      )

      await Promise.all(
        members.map((did) =>
          store.stageSpaceSyncPage({
            spaceUri,
            did,
            boundary: 'bounty-hunters',
            mutations: [],
            updatedAt: indexedAt,
          }),
        ),
      )
      expect(
        await Promise.all(
          members.map((did) => store.resetPendingSpaceSyncState(spaceUri, did)),
        ),
      ).toEqual(members.map(() => true))
    } finally {
      await store.close()
    }
  })

  it('imports legacy membership snapshots once without moving cursors', async () => {
    const legacyPath = await makeTempDbPath()
    const membershipPath = await makeTempDbPath()
    const legacyDb = createSqliteDb(legacyPath)
    await migrateSqliteDb(legacyDb)
    const legacyStore = new SqliteFeedgenStore(legacyDb)
    const did = 'did:plc:fayevalentine'
    const spaceUri = `at://${did}/zone.stratos.space/bebop`
    const indexedAt = '2024-01-01T00:00:00.000Z'

    await legacyStore.upsertCursor(did, 99, indexedAt)
    await legacyStore.upsertSpaceCursor(spaceUri, did, 'cursor-99', indexedAt)
    await legacyStore.upsertEnrolledActor({
      did,
      boundaries: ['red-tail'],
      enrolledAt: indexedAt,
      lastSeenAt: indexedAt,
    })
    await legacyStore.replaceSpaceMembers('red-tail', [
      { did, custody: 'pds', host: 'https://red-tail.example' },
    ])

    await legacyStore.close()
    const firstSplitStore = await createFeedgenStore(
      sqliteConfig(legacyPath, membershipPath),
    )
    expect(await firstSplitStore.getEnrolledActor(did)).toEqual({
      did,
      boundaries: ['red-tail'],
      enrolledAt: indexedAt,
      lastSeenAt: indexedAt,
    })
    await firstSplitStore.close()

    const changedLegacyDb = createSqliteDb(legacyPath)
    const changedLegacyStore = new SqliteFeedgenStore(changedLegacyDb)
    await changedLegacyStore.upsertEnrolledActor({
      did,
      boundaries: ['changed-after-import'],
      enrolledAt: indexedAt,
      lastSeenAt: '2024-01-02T00:00:00.000Z',
    })
    await changedLegacyStore.close()

    const restartedSplitStore = await createFeedgenStore(
      sqliteConfig(legacyPath, membershipPath),
    )
    expect(await restartedSplitStore.getEnrolledActor(did)).toEqual({
      did,
      boundaries: ['red-tail'],
      enrolledAt: indexedAt,
      lastSeenAt: indexedAt,
    })
    expect(await restartedSplitStore.listSpaceMembers('red-tail')).toEqual([
      { did, custody: 'pds', host: 'https://red-tail.example' },
    ])
    await restartedSplitStore.close()

    const membershipDb = createSqliteDb(membershipPath)
    await membershipDb._initialized
    expect(
      await membershipDb.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'sync_cursor',
            'space_sync_cursor',
            'space_sync_pending_verification',
            'space_sync_stage'
          )
      `),
    ).toEqual([])
    membershipDb._client.close()
  })

  it('persists an explicit file database across reopen', async () => {
    const dbPath = await makeTempDbPath()
    const firstDb = createSqliteDb(dbPath)
    await migrateSqliteDb(firstDb)
    const first = new SqliteFeedgenStore(firstDb)
    await first.upsertCursor(
      'did:plc:motokokusanagi',
      9,
      '2024-01-01T00:00:00.000Z',
    )
    await first.close()

    const secondDb = createSqliteDb(dbPath)
    await migrateSqliteDb(secondDb)
    const second = new SqliteFeedgenStore(secondDb)
    try {
      expect(await second.getCursor('did:plc:motokokusanagi')).toBe(9)
    } finally {
      await second.close()
    }
  })
})
