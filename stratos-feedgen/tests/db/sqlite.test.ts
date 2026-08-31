import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import {
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
    await db._initialized
    const result = await db.get<{ journal_mode: string }>(
      sql`PRAGMA journal_mode`,
    )
    expect(result?.journal_mode).toBe('memory')
    db._client.close()
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
        'did:plc:linaminmay',
        7,
        '2024-01-01T00:00:00.000Z',
      )
      expect(await first.getCursor('did:plc:linaminmay')).toBe(7)
      expect(await second.getCursor('did:plc:linaminmay')).toBeNull()
    } finally {
      await first.close()
      await second.close()
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
