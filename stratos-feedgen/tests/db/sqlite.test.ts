import { mkdtemp, rm } from 'node:fs/promises'
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

async function makeTempDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'feedgen-sqlite-'))
  tempDirs.push(dir)
  return join(dir, 'feedgen.sqlite')
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
    await store.upsertCursor('did:plc:idempotent', 1, '2024-01-01T00:00:00.000Z')
    expect(await store.getCursor('did:plc:idempotent')).toBe(1)
    await store.close()
  })
})
