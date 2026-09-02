import { mkdtemp, rm } from 'node:fs/promises'
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
    FEEDGEN_SQLITE_PATH: recordPath,
    FEEDGEN_MEMBERSHIP_SQLITE_PATH: membershipPath,
  })
}

describeStoreContract('sqlite', {
  async build() {
    const dbPath = await makeTempDbPath()
    const db = createSqliteDb(dbPath)
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
})
