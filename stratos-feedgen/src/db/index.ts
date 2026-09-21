import { assertDistinctSqlitePaths, type FeedgenConfig } from '../config.js'
import { createPgDb, migratePgDb, PgFeedgenStore } from './postgres.js'
import {
  createSqliteDb,
  importLegacyMembershipSnapshots,
  migrateMembershipSqliteDb,
  migrateRecordSqliteDb,
  SqliteFeedgenStore,
} from './sqlite.js'
import type { FeedgenStore, ProjectionCompactionStore } from './types.js'

export * from './types.js'
export * from './sqlite.js'
export * from './postgres.js'

export function isProjectionCompactionStore(
  store: FeedgenStore,
): store is FeedgenStore & ProjectionCompactionStore {
  return 'compactProjection' in store
}

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
    if (cfg.membershipSqlitePath.startsWith(':memory:')) {
      throw new Error('membershipSqlitePath must be a file path')
    }
    if (cfg.sqlitePath !== ':memory:') {
      assertDistinctSqlitePaths(cfg.sqlitePath, cfg.membershipSqlitePath)
    }
    const recordDb = createSqliteDb(cfg.sqlitePath)
    const membershipDb = createSqliteDb(cfg.membershipSqlitePath)
    await Promise.all([
      migrateRecordSqliteDb(recordDb),
      migrateMembershipSqliteDb(membershipDb),
    ])
    await importLegacyMembershipSnapshots(recordDb, membershipDb)
    return new SqliteFeedgenStore(
      recordDb,
      membershipDb,
      cfg.storageProfile === 'encrypted-volume'
        ? {
            maxAgeMs: requireProjectionValue(
              cfg.projectionMaxAgeMs,
              'projectionMaxAgeMs',
            ),
            maxBytes: requireProjectionValue(
              cfg.projectionMaxBytes,
              'projectionMaxBytes',
            ),
          }
        : undefined,
    )
  }
  if (!cfg.postgresUrl) {
    throw new Error('postgresUrl is required for postgres backend')
  }
  const db = createPgDb(cfg.postgresUrl, cfg.postgresSchema)
  await migratePgDb(db, cfg.postgresSchema)
  return new PgFeedgenStore(db)
}

function requireProjectionValue(
  value: number | undefined,
  field: string,
): number {
  if (value === undefined) {
    throw new Error(`${field} is required for encrypted-volume storage`)
  }
  return value
}
