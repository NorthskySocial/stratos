import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { EnrollmentStoreWriter } from '@northskysocial/stratos-core'
import { SqliteEnrollmentStore } from '../src/context.js'
import { CachedEnrollmentStore } from '../src/infra/storage/cached-enrollment-store.js'
import { ReservedDomainEnrollmentStore } from '../src/infra/storage/reserved-domain-enrollment-store.js'
import {
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from '../src/db/index.js'

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

describe('enrollment operatorHold on SQLite', () => {
  let tmp: string
  let db: ServiceDb
  let store: SqliteEnrollmentStore

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'stratos-operator-hold-'))
    db = createServiceDb(join(tmp, 'service.sqlite'))
    await migrateServiceDb(db)
    store = new SqliteEnrollmentStore(db)
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
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
      (inner: SqliteEnrollmentStore) =>
        new ReservedDomainEnrollmentStore(inner, RESERVED),
    ],
    [
      'the cached decorator',
      (inner: SqliteEnrollmentStore) =>
        new CachedEnrollmentStore(inner as unknown as EnrollmentStoreWriter),
    ],
  ])('round-trips operatorHold through %s', async (_name, decorate) => {
    const decorated = decorate(store)
    await decorated.enroll(newEnrollment(SPIKE_DID))

    await decorated.updateEnrollment(SPIKE_DID, { operatorHold: true })

    expect((await decorated.getEnrollment(SPIKE_DID))?.operatorHold).toBe(true)
    expect((await store.getEnrollment(SPIKE_DID))?.operatorHold).toBe(true)
  })

  describe('migration', () => {
    async function createPreMigrationTable(legacyDb: ServiceDb) {
      await legacyDb.run(sql`
        CREATE TABLE enrollment (
          did TEXT PRIMARY KEY,
          enrolledAt TEXT NOT NULL,
          pdsEndpoint TEXT,
          signingKeyDid TEXT NOT NULL,
          active TEXT NOT NULL DEFAULT 'true',
          enrollmentRkey TEXT,
          isService INTEGER NOT NULL DEFAULT 0,
          custody TEXT NOT NULL DEFAULT 'stratos',
          repoHost TEXT,
          capabilityVerdict TEXT
        )
      `)
      await legacyDb.run(sql`
        INSERT INTO enrollment (did, enrolledAt, signingKeyDid, active) VALUES
          (${SPIKE_DID}, '2024-12-01T00:00:00Z', 'did:key:zDnaeBebop', 'true'),
          (${FAYE_DID}, '2024-12-01T00:00:00Z', 'did:key:zDnaeBebop', 'false')
      `)
    }

    it('marks rows inactive at the time the column is added as operator-held', async () => {
      const legacyDb = createServiceDb(join(tmp, 'legacy.sqlite'))
      await createPreMigrationTable(legacyDb)

      await migrateServiceDb(legacyDb)

      const legacyStore = new SqliteEnrollmentStore(legacyDb)
      expect((await legacyStore.getEnrollment(SPIKE_DID))?.operatorHold).toBe(
        false,
      )
      expect((await legacyStore.getEnrollment(FAYE_DID))?.operatorHold).toBe(
        true,
      )
    })

    it('does not backfill again on a later migration', async () => {
      const legacyDb = createServiceDb(join(tmp, 'legacy.sqlite'))
      await createPreMigrationTable(legacyDb)
      await migrateServiceDb(legacyDb)
      const legacyStore = new SqliteEnrollmentStore(legacyDb)
      await legacyStore.enroll({ ...newEnrollment(JET_DID), active: true })
      await legacyStore.updateEnrollment(JET_DID, { active: false })

      await migrateServiceDb(legacyDb)

      const takedownShaped = await legacyStore.getEnrollment(JET_DID)
      expect(takedownShaped?.active).toBe(false)
      expect(takedownShaped?.operatorHold).toBe(false)
    })

    it('migrates an in-memory database and keeps its tables', async () => {
      const memoryDb = createServiceDb(':memory:')
      await migrateServiceDb(memoryDb)
      const memoryStore = new SqliteEnrollmentStore(memoryDb)

      await memoryStore.enroll(newEnrollment(SPIKE_DID))

      const member = await memoryStore.getEnrollment(SPIKE_DID)
      expect(member?.did).toBe(SPIKE_DID)
      expect(member?.operatorHold).toBe(false)
    })

    it('backfills once on an in-memory database', async () => {
      const memoryDb = createServiceDb(':memory:')
      await createPreMigrationTable(memoryDb)

      await migrateServiceDb(memoryDb)

      const memoryStore = new SqliteEnrollmentStore(memoryDb)
      expect((await memoryStore.getEnrollment(FAYE_DID))?.operatorHold).toBe(
        true,
      )
      await memoryStore.enroll(newEnrollment(JET_DID))
      await memoryStore.updateEnrollment(JET_DID, { active: false })

      await migrateServiceDb(memoryDb)

      expect((await memoryStore.getEnrollment(JET_DID))?.operatorHold).toBe(
        false,
      )
      expect((await memoryStore.getEnrollment(FAYE_DID))?.operatorHold).toBe(
        true,
      )
    })
  })
})
