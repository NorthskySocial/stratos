import type { FeedgenConfig } from '../config.js'
import { createPgDb, migratePgDb, PgFeedgenStore } from './postgres.js'
import {
  createSqliteDb,
  importLegacyMembershipSnapshots,
  migrateMembershipSqliteDb,
  migrateRecordSqliteDb,
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
    if (!cfg.membershipSqlitePath) {
      throw new Error('membershipSqlitePath is required for sqlite backend')
    }
    if (cfg.membershipSqlitePath === cfg.sqlitePath) {
      throw new Error('membershipSqlitePath must differ from sqlitePath')
    }
    const recordDb = createSqliteDb(cfg.sqlitePath)
    const membershipDb = createSqliteDb(cfg.membershipSqlitePath)
    await Promise.all([
      migrateRecordSqliteDb(recordDb),
      migrateMembershipSqliteDb(membershipDb),
    ])
    await importLegacyMembershipSnapshots(recordDb, membershipDb)
    return new SqliteFeedgenStore(recordDb, membershipDb)
  }
  if (!cfg.postgresUrl) {
    throw new Error('postgresUrl is required for postgres backend')
  }
  const db = createPgDb(cfg.postgresUrl, cfg.postgresSchema)
  await migratePgDb(db, cfg.postgresSchema)
  return new PgFeedgenStore(db)
}
