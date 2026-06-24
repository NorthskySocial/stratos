import type { FeedgenConfig } from '../config.js'
import { createPgDb, migratePgDb, PgFeedgenStore } from './postgres.js'
import {
  createSqliteDb,
  migrateSqliteDb,
  SqliteFeedgenStore,
} from './sqlite.js'
import type { FeedgenStore } from './types.js'

export * from './types.js'
export * from './sqlite.js'
export * from './postgres.js'

export async function createFeedgenStore(
  cfg: FeedgenConfig,
): Promise<FeedgenStore> {
  if (cfg.storageBackend === 'sqlite') {
    if (!cfg.sqlitePath) {
      throw new Error('sqlitePath is required for sqlite backend')
    }
    const db = createSqliteDb(cfg.sqlitePath)
    await migrateSqliteDb(db)
    return new SqliteFeedgenStore(db)
  }
  if (!cfg.postgresUrl) {
    throw new Error('postgresUrl is required for postgres backend')
  }
  const db = createPgDb(cfg.postgresUrl, cfg.postgresSchema)
  await migratePgDb(db, cfg.postgresSchema)
  return new PgFeedgenStore(db)
}
