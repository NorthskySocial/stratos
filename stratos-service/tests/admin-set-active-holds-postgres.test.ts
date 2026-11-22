/**
 * setActive and callback hold behaviour against the Postgres stores. Mirrors
 * admin-set-active-holds.test.ts so both backends hold the same contract.
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
import { PgLabelStore } from '../src/features/moderation/index.js'
import { PgPdsSyncQueueStore } from '../src/features/enrollment/index.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'
import {
  defineCallbackHoldScenarios,
  defineInFlightUnenrollScenarios,
  defineSetActiveScenarios,
  RESERVED_BOUNDARY,
  type HoldsBackend,
} from './helpers/enrollment-holds.js'

describe('admin setActive and callback holds on Postgres', () => {
  let rawClient: postgres.Sql
  let db: ServicePgDb
  let backend: HoldsBackend

  beforeAll(async () => {
    const pgUrl = await startPostgresContainer()
    rawClient = postgres(pgUrl, { max: 1 })
    db = createServicePgDb(pgUrl)
    await migrateServicePgDb(db)
    backend = {
      enrollmentStore: new ReservedDomainEnrollmentStore(
        new PgEnrollmentStoreWriter(db),
        RESERVED_BOUNDARY,
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
    await rawClient`DELETE FROM enrollment`
    await rawClient`TRUNCATE "moderation_label" RESTART IDENTITY`
  })

  defineSetActiveScenarios(() => backend)
  defineCallbackHoldScenarios(() => backend)
  defineInFlightUnenrollScenarios(() => backend)
})
