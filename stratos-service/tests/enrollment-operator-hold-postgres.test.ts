/**
 * enrollment operatorHold against the Postgres store and migration. Mirrors
 * enrollment-operator-hold.test.ts so both backends hold the same contract.
 *
 * Requires Docker; starts its own PostgreSQL container.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import type { EnrollmentStoreWriter } from '@northskysocial/stratos-core'
import {
  closeServicePgDb,
  createServicePgDb,
  migrateServicePgDb,
  type ServicePgDb,
} from '../src/db/pg.js'
import { PgEnrollmentStoreWriter } from '../src/infra/storage/postgres/index.js'
import { CachedEnrollmentStore } from '../src/infra/storage/cached-enrollment-store.js'
import { ReservedDomainEnrollmentStore } from '../src/infra/storage/reserved-domain-enrollment-store.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const SPIKE_DID = 'did:plc:spikespiegel'
const FAYE_DID = 'did:plc:fayevalentine'
const JET_DID = 'did:plc:jetblack'
const RESERVED = 'did:web:bebop.example/crew'

function newEnrollment(did: string, active = true) {
  return {
    did,
    enrolledAt: '2025-01-01T00:00:00Z',
    pdsEndpoint: 'https://pds.example.com',
    signingKeyDid: 'did:key:zDnaeBebop',
    active,
  }
}

describe('enrollment operatorHold on Postgres', () => {
  let rawClient: postgres.Sql
  let db: ServicePgDb
  let store: PgEnrollmentStoreWriter

  beforeAll(async () => {
    const pgUrl = await startPostgresContainer()
    rawClient = postgres(pgUrl, { max: 1 })
    db = createServicePgDb(pgUrl)
    store = new PgEnrollmentStoreWriter(db)
  }, 120_000)

  afterAll(async () => {
    await closeServicePgDb(db)
    await rawClient.end()
    await stopPostgresContainer()
  })

  beforeEach(async () => {
    await migrateServicePgDb(db)
    await rawClient`DELETE FROM enrollment`
  })

  it('reads operatorHold false for a new enrollment', async () => {
    await store.enroll(newEnrollment(SPIKE_DID))

    expect((await store.getEnrollment(SPIKE_DID))?.operatorHold).toBe(false)
    expect((await store.listEnrollments())[0].operatorHold).toBe(false)
  })

  it('round-trips operatorHold through updateEnrollment without touching active', async () => {
    await store.enroll(newEnrollment(SPIKE_DID))

    await store.updateEnrollment(SPIKE_DID, { operatorHold: true })

    const held = await store.getEnrollment(SPIKE_DID)
    expect(held?.operatorHold).toBe(true)
    expect(held?.active).toBe(true)

    await store.updateEnrollment(SPIKE_DID, { operatorHold: false })
    expect((await store.getEnrollment(SPIKE_DID))?.operatorHold).toBe(false)
  })

  it('writes operatorHold given to enroll', async () => {
    await store.enroll({
      ...newEnrollment(FAYE_DID, false),
      operatorHold: true,
    })

    expect((await store.getEnrollment(FAYE_DID))?.operatorHold).toBe(true)
  })

  it('keeps operatorHold when the same DID enrolls again', async () => {
    await store.enroll(newEnrollment(SPIKE_DID))
    await store.updateEnrollment(SPIKE_DID, { operatorHold: true })

    await store.enroll(newEnrollment(SPIKE_DID))

    expect((await store.getEnrollment(SPIKE_DID))?.operatorHold).toBe(true)
  })

  it.each([
    [
      'the reserved-domain decorator',
      (inner: PgEnrollmentStoreWriter) =>
        new ReservedDomainEnrollmentStore(inner, RESERVED),
    ],
    [
      'the cached decorator',
      (inner: PgEnrollmentStoreWriter) =>
        new CachedEnrollmentStore(inner as EnrollmentStoreWriter),
    ],
  ])('round-trips operatorHold through %s', async (_name, decorate) => {
    const decorated = decorate(store)
    await decorated.enroll(newEnrollment(SPIKE_DID))

    await decorated.updateEnrollment(SPIKE_DID, { operatorHold: true })

    expect((await decorated.getEnrollment(SPIKE_DID))?.operatorHold).toBe(true)
    expect((await store.getEnrollment(SPIKE_DID))?.operatorHold).toBe(true)
  })

  describe('migration', () => {
    async function createPreMigrationTable() {
      await rawClient`DROP TABLE "enrollment"`
      await rawClient`
        CREATE TABLE "enrollment" (
          "did" TEXT PRIMARY KEY,
          "enrolledAt" TEXT NOT NULL,
          "pdsEndpoint" TEXT,
          "signingKeyDid" TEXT NOT NULL,
          "active" TEXT NOT NULL DEFAULT 'true',
          "enrollmentRkey" TEXT,
          "isService" BOOLEAN NOT NULL DEFAULT FALSE,
          "custody" TEXT NOT NULL DEFAULT 'stratos',
          "repoHost" TEXT,
          "capabilityVerdict" TEXT
        )
      `
      await rawClient`
        INSERT INTO "enrollment" ("did", "enrolledAt", "signingKeyDid", "active")
        VALUES
          (${SPIKE_DID}, '2024-12-01T00:00:00Z', 'did:key:zDnaeBebop', 'true'),
          (${FAYE_DID}, '2024-12-01T00:00:00Z', 'did:key:zDnaeBebop', 'false')
      `
    }

    it('marks rows inactive at the time the column is added as operator-held', async () => {
      await createPreMigrationTable()

      await migrateServicePgDb(db)

      expect((await store.getEnrollment(SPIKE_DID))?.operatorHold).toBe(false)
      expect((await store.getEnrollment(FAYE_DID))?.operatorHold).toBe(true)
    })

    it('does not backfill again on a later migration', async () => {
      await createPreMigrationTable()
      await migrateServicePgDb(db)
      await store.enroll(newEnrollment(JET_DID))
      await store.updateEnrollment(JET_DID, { active: false })

      await migrateServicePgDb(db)

      const takedownShaped = await store.getEnrollment(JET_DID)
      expect(takedownShaped?.active).toBe(false)
      expect(takedownShaped?.operatorHold).toBe(false)
    })
  })
})
