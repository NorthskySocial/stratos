/**
 * Account-subject createLabel against the Postgres stores. Mirrors the shared
 * scenarios in moderation-account-label.test.ts so both backends hold the same
 * contract.
 *
 * Requires Docker; starts its own PostgreSQL container.
 */
import { afterAll, beforeAll, beforeEach, describe } from 'vitest'
import postgres from 'postgres'
import {
  closeServicePgDb,
  createServicePgDb,
  migrateServicePgDb,
  type ServicePgDb,
} from '../src/db/pg.js'
import { PgEnrollmentStoreWriter } from '../src/infra/storage/postgres/index.js'
import { ReservedDomainEnrollmentStore } from '../src/infra/storage/reserved-domain-enrollment-store.js'
import { ActiveBoundaryEnrollmentStore } from '../src/features/boundary/enrollment-store.js'
import { migratePgBoundaries } from '../src/features/boundary/migrate.js'
import { createPgBoundaryStore } from '../src/features/boundary/store.js'
import { PgLabelStore } from '../src/features/moderation/index.js'
import { PgPdsSyncQueueStore } from '../src/features/enrollment/index.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'
import {
  defineAccountLabelScenarios,
  RESERVED_BOUNDARY,
  seedBoundaryCatalog,
  type HoldsBackend,
} from './helpers/enrollment-holds.js'

describe('account subjects in createLabel on Postgres', () => {
  let rawClient: postgres.Sql
  let db: ServicePgDb
  let backend: HoldsBackend

  beforeAll(async () => {
    const pgUrl = await startPostgresContainer()
    rawClient = postgres(pgUrl, { max: 1 })
    db = createServicePgDb(pgUrl)
    await migrateServicePgDb(db)
    await migratePgBoundaries(db)
    const catalog = createPgBoundaryStore(db)
    await seedBoundaryCatalog(catalog)
    backend = {
      enrollmentStore: new ActiveBoundaryEnrollmentStore(
        new ReservedDomainEnrollmentStore(
          new PgEnrollmentStoreWriter(db),
          RESERVED_BOUNDARY,
        ),
        catalog,
      ),
      labelStore: new PgLabelStore(db),
      pdsSyncQueue: new PgPdsSyncQueueStore(db),
    }
  }, 120_000)

  afterAll(async () => {
    await closeServicePgDb(db)
    await rawClient.end()
    await stopPostgresContainer()
  }, 60_000)

  beforeEach(async () => {
    await rawClient`DELETE FROM enrollment_boundary`
    await rawClient`DELETE FROM enrollment`
    await rawClient`TRUNCATE "moderation_label" RESTART IDENTITY`
  })

  defineAccountLabelScenarios(() => backend)
})
