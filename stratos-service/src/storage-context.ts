import path from 'node:path'
import * as fs from 'node:fs/promises'
import { sql } from 'drizzle-orm'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from './db'
import {
  checkServicePgDbStartup,
  closeServicePgDb,
  createServicePgDb,
  migrateServicePgDb,
} from './db/pg.js'
import { CachedEnrollmentStore } from './infra/storage/cached-enrollment-store.js'
import { ReservedDomainEnrollmentStore } from './infra/storage/reserved-domain-enrollment-store.js'
import {
  createPgOAuthStores,
  createSqliteOAuthStores,
  PgAdminSessionStore,
  PgAdminUserStore,
  SqliteAdminSessionStore,
  SqliteAdminUserStore,
  type AdminSessionStore,
  type AdminUserStore,
  type EnrollmentStore,
  type OAuthSessionStoreBackend,
  type OAuthStateStoreBackend,
} from './oauth'
import { SqliteEnrollmentStore } from './storage/sqlite/enrollment-store.js'
import {
  PgPdsSyncQueueStore,
  SqlitePdsSyncQueueStore,
  type PdsSyncQueueStore,
} from './features/enrollment/internal/pds-sync-store.js'
import { StratosActorStore } from './storage/sqlite/actor-store.js'
import type {
  EnrollmentStoreReader,
  Logger,
} from '@northskysocial/stratos-core'
import type { ActorStore } from './actor-store-types.js'
import type { AppContextOptions } from './context-types.js'
import {
  PgEnrollmentStoreWriter,
  PostgresActorStore,
} from './infra/storage/postgres'

export interface StorageContext {
  db?: ServiceDb
  actorStore: ActorStore
  enrollmentStore: EnrollmentStore & EnrollmentStoreReader
  oauthStores: {
    sessionStore: OAuthSessionStoreBackend
    stateStore: OAuthStateStoreBackend
  }
  adminSessionStore: AdminSessionStore
  adminUserStore: AdminUserStore
  pdsSyncQueue: PdsSyncQueueStore
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
  let adminSessionStore: AdminSessionStore
  let adminUserStore: AdminUserStore
  let pdsSyncQueue: PdsSyncQueueStore
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
    enrollmentStore = new ReservedDomainEnrollmentStore(
      cachedEnrollmentStore,
      cfg.stratos.reservedDomain,
    )
    oauthStores = createPgOAuthStores(pgDb)
    adminSessionStore = new PgAdminSessionStore(pgDb, logger)
    adminUserStore = new PgAdminUserStore(pgDb, logger)
    pdsSyncQueue = new PgPdsSyncQueueStore(pgDb)
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
    enrollmentStore = new ReservedDomainEnrollmentStore(
      new SqliteEnrollmentStore(db),
      cfg.stratos.reservedDomain,
    )
    oauthStores = createSqliteOAuthStores(db)
    adminSessionStore = new SqliteAdminSessionStore(db, logger)
    adminUserStore = new SqliteAdminUserStore(db, logger)
    pdsSyncQueue = new SqlitePdsSyncQueueStore(db)
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

  const sweep = scheduleExpiredSessionSweep(adminSessionStore, logger)
  const closeBackend = destroy
  destroy = async () => {
    sweep.stop()
    await closeBackend()
  }

  return {
    db,
    enrollmentStore,
    oauthStores,
    adminSessionStore,
    adminUserStore,
    pdsSyncQueue,
    actorStore,
    checkDbHealth,
    destroy,
  }
}

/**
 * Interval between periodic expired-admin-session sweeps. Sessions are also
 * purged lazily on read; this bound keeps the table from growing without limit
 * when expired sessions are never read again.
 */
const ADMIN_SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000

/**
 * Start a periodic sweep that deletes expired admin sessions. The timer is
 * `unref`'d so it never keeps the process alive, and {@link ScheduledSweep.stop}
 * clears it during shutdown.
 */
function scheduleExpiredSessionSweep(
  store: AdminSessionStore,
  logger?: Logger,
): ScheduledSweep {
  const timer = setInterval(() => {
    store
      .deleteExpired()
      .then((removed) => {
        if (removed > 0) {
          logger?.info({ removed }, 'admin session: swept expired sessions')
        }
      })
      .catch((err) => {
        logger?.warn({ err }, 'admin session: expired sweep failed')
      })
  }, ADMIN_SESSION_SWEEP_INTERVAL_MS)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}

interface ScheduledSweep {
  stop: () => void
}
