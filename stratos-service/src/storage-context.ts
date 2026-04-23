import path from 'node:path'
import * as fs from 'node:fs/promises'
import { sql } from 'drizzle-orm'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from './db/index.js'
import {
  checkServicePgDbStartup,
  closeServicePgDb,
  createServicePgDb,
  migrateServicePgDb,
} from './db/pg.js'
import { CachedEnrollmentStore } from './infra/storage/cached-enrollment-store.js'
import { type EnrollmentStore } from './oauth/routes.js'
import { SqliteEnrollmentStore } from './storage/sqlite/enrollment-store.js'
import { StratosActorStore } from './storage/sqlite/actor-store.js'
import {
  createPgOAuthStores,
  createSqliteOAuthStores,
  type OAuthSessionStoreBackend,
  type OAuthStateStoreBackend,
} from './oauth/client.js'
import type { EnrollmentStoreReader } from '@northskysocial/stratos-core'
import type { ActorStore } from './actor-store-types.js'
import type { AppContextOptions } from './context-types.js'
import {
  PgEnrollmentStoreWriter,
  PostgresActorStore,
} from './infra/storage/postgres/index.js'

export interface StorageContext {
  db?: ServiceDb
  actorStore: ActorStore
  enrollmentStore: EnrollmentStore & EnrollmentStoreReader
  oauthStores: {
    sessionStore: OAuthSessionStoreBackend
    stateStore: OAuthStateStoreBackend
  }
  checkDbHealth: () => Promise<'ok' | 'error'>
  destroy: () => Promise<void>
}

/**
 * Create storage context (database, enrollment store, actor store, oauth stores)
 *
 * @param opts - Configuration options for the storage context.
 * @returns Initialized storage context.
 */
export async function createStorageContext(
  opts: AppContextOptions,
): Promise<StorageContext> {
  const { cfg, blobstore, cborToRecord, logger } = opts

  const serviceDbPath = path.join(cfg.storage.dataDir, 'service.sqlite')
  await fs.mkdir(cfg.storage.dataDir, { recursive: true })

  let db: ServiceDb | undefined
  let enrollmentStore: EnrollmentStore & EnrollmentStoreReader
  let oauthStores: {
    sessionStore: OAuthSessionStoreBackend
    stateStore: OAuthStateStoreBackend
  }
  let actorStore: ActorStore
  let checkDbHealth: () => Promise<'ok' | 'error'>
  let destroy: () => Promise<void>

  if (cfg.storage.backend === 'postgres') {
    if (!cfg.storage.postgresUrl) {
      throw new Error(
        'STRATOS_POSTGRES_URL is required when backend is postgres',
      )
    }
    const pgDb = createServicePgDb(cfg.storage.postgresUrl)
    const pgStartup = await checkServicePgDbStartup(pgDb)
    logger?.info(
      {
        database: pgStartup.currentDatabase,
        user: pgStartup.currentUser,
        schema: pgStartup.currentSchema,
        searchPath: pgStartup.searchPath,
        hasDatabaseCreate: pgStartup.hasDatabaseCreate,
        hasSchemaUsage: pgStartup.hasSchemaUsage,
        hasSchemaCreate: pgStartup.hasSchemaCreate,
      },
      'postgres service database preflight passed',
    )
    await migrateServicePgDb(pgDb)
    const pgEnrollmentStore = new PgEnrollmentStoreWriter(pgDb)
    const cachedEnrollmentStore = new CachedEnrollmentStore(pgEnrollmentStore, {
      cacheTtlMs: 5 * 60 * 1000,
    })
    await cachedEnrollmentStore.warm()
    enrollmentStore = cachedEnrollmentStore
    oauthStores = createPgOAuthStores(pgDb)
    actorStore = new PostgresActorStore({
      connectionString: cfg.storage.postgresUrl,
      blobstore,
      cborToRecord,
      logger,
      actorPoolSize: cfg.storage.pgActorPoolSize,
      adminPoolSize: cfg.storage.pgAdminPoolSize,
      blockCacheSize: cfg.storage.blockCacheSize,
    })
    checkDbHealth = () =>
      pgDb.execute(sql`SELECT 1`).then(
        () => 'ok' as const,
        () => 'error' as const,
      )
    destroy = async () => {
      await closeServicePgDb(pgDb)
    }
  } else {
    db = createServiceDb(serviceDbPath)
    await migrateServiceDb(db)
    enrollmentStore = new SqliteEnrollmentStore(db)
    oauthStores = createSqliteOAuthStores(db)
    actorStore = new StratosActorStore({
      dataDir: path.join(cfg.storage.dataDir, 'actors'),
      blobstore,
      cborToRecord,
      logger,
    })
    checkDbHealth = () =>
      db!.run(sql`SELECT 1`).then(
        () => 'ok' as const,
        () => 'error' as const,
      )
    destroy = async () => {
      await closeServiceDb(db!)
    }
  }

  return {
    db,
    enrollmentStore,
    oauthStores,
    actorStore,
    checkDbHealth,
    destroy,
  }
}
