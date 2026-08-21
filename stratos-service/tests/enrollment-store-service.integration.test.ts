import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { SqliteEnrollmentStore } from '../src/context.js'
import { createServiceDb, migrateServiceDb, type ServiceDb } from '../src/db'

const USER_DID = 'did:plc:asukalangleysoryu'
const SERVICE_DID = 'did:web:nerv.example.com'

describe('SqliteEnrollmentStore isService support', () => {
  let testDir: string
  let db: ServiceDb
  let store: SqliteEnrollmentStore

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-enrollment-svc-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })
    db = createServiceDb(join(testDir, 'service.sqlite'))
    await migrateServiceDb(db)
    store = new SqliteEnrollmentStore(db)
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('defaults isService to false for user enrollments', async () => {
    await store.enroll({
      did: USER_DID,
      enrolledAt: '2025-01-01T00:00:00Z',
      pdsEndpoint: 'https://pds.example.com',
      signingKeyDid: 'did:key:zDnaeUserKey',
      active: true,
      boundaries: ['pilot'],
    })

    const enrollment = await store.getEnrollment(USER_DID)
    expect(enrollment).not.toBeNull()
    expect(enrollment?.isService).toBe(false)
    expect(enrollment?.pdsEndpoint).toBe('https://pds.example.com')
  })

  it('round-trips a service enrollment with NULL pdsEndpoint', async () => {
    await store.enroll({
      did: SERVICE_DID,
      enrolledAt: '2025-01-02T00:00:00Z',
      signingKeyDid: SERVICE_DID,
      active: true,
      boundaries: ['leadership'],
    })
    await store.updateEnrollment(SERVICE_DID, { isService: true })

    const enrollment = await store.getEnrollment(SERVICE_DID)
    expect(enrollment).not.toBeNull()
    expect(enrollment?.isService).toBe(true)
    expect(enrollment?.pdsEndpoint).toBeUndefined()
    expect(enrollment?.signingKeyDid).toBe(SERVICE_DID)

    const boundaries = await store.getBoundaries(SERVICE_DID)
    expect(boundaries).toEqual(['leadership'])
  })

  it('distinguishes a service row from a user row by isService alone, not pdsEndpoint', async () => {
    // User row with an *empty* pdsEndpoint.
    await store.enroll({
      did: USER_DID,
      enrolledAt: '2025-01-01T00:00:00Z',
      pdsEndpoint: '',
      signingKeyDid: 'did:key:zDnaeUserKey',
      active: true,
      boundaries: ['pilot'],
    })
    // Service row with a NULL pdsEndpoint.
    await store.enroll({
      did: SERVICE_DID,
      enrolledAt: '2025-01-02T00:00:00Z',
      signingKeyDid: SERVICE_DID,
      active: true,
      boundaries: ['leadership'],
    })
    await store.updateEnrollment(SERVICE_DID, { isService: true })

    const user = await store.getEnrollment(USER_DID)
    const service = await store.getEnrollment(SERVICE_DID)

    // Neither carries a meaningful pdsEndpoint, so the flag is the only
    // discriminator between a user and a service enrollment.
    expect(user?.isService).toBe(false)
    expect(service?.isService).toBe(true)

    const services = await store.listServiceEnrollments()
    expect(services.map((e) => e.did)).toEqual([SERVICE_DID])
  })

  it('listServiceEnrollments returns only service rows', async () => {
    await store.enroll({
      did: USER_DID,
      enrolledAt: '2025-01-01T00:00:00Z',
      pdsEndpoint: 'https://pds.example.com',
      signingKeyDid: 'did:key:zDnaeUserKey',
      active: true,
    })
    await store.enroll({
      did: SERVICE_DID,
      enrolledAt: '2025-01-02T00:00:00Z',
      signingKeyDid: SERVICE_DID,
      active: true,
    })
    await store.updateEnrollment(SERVICE_DID, { isService: true })

    const serviceEnrollments = await store.listServiceEnrollments()
    expect(serviceEnrollments).toHaveLength(1)
    expect(serviceEnrollments[0].did).toBe(SERVICE_DID)
    expect(serviceEnrollments[0].isService).toBe(true)
  })

  it('isEnrolled is true only for active rows', async () => {
    await store.enroll({
      did: USER_DID,
      enrolledAt: '2025-01-01T00:00:00Z',
      pdsEndpoint: 'https://pds.example.com',
      signingKeyDid: 'did:key:zDnaeUserKey',
      active: true,
    })
    expect(await store.isEnrolled(USER_DID)).toBe(true)
    expect(await store.isEnrolled('did:plc:doesnotexist')).toBe(false)

    await store.updateEnrollment(USER_DID, { active: false })
    expect(await store.isEnrolled(USER_DID)).toBe(false)
  })

  it('enroll persists boundaries and getEnrollment maps every field', async () => {
    await store.enroll({
      did: USER_DID,
      enrolledAt: '2025-01-01T00:00:00Z',
      pdsEndpoint: 'https://pds.example.com',
      signingKeyDid: 'did:key:zDnaeUserKey',
      active: true,
      enrollmentRkey: '3kabc',
      boundaries: ['pilot', 'medical'],
    })

    const enrollment = await store.getEnrollment(USER_DID)
    expect(enrollment).toEqual({
      did: USER_DID,
      enrolledAt: '2025-01-01T00:00:00Z',
      pdsEndpoint: 'https://pds.example.com',
      signingKeyDid: 'did:key:zDnaeUserKey',
      active: true,
      enrollmentRkey: '3kabc',
      isService: false,
    })
    expect(await store.getBoundaries(USER_DID)).toEqual(
      expect.arrayContaining(['pilot', 'medical']),
    )
    expect(await store.getEnrollment('did:plc:missing')).toBeNull()
  })

  it('getEnrollment maps inactive rows and absent optional fields', async () => {
    await store.enroll({
      did: SERVICE_DID,
      enrolledAt: '2025-01-02T00:00:00Z',
      signingKeyDid: SERVICE_DID,
      active: false,
    })

    const enrollment = await store.getEnrollment(SERVICE_DID)
    expect(enrollment?.active).toBe(false)
    expect(enrollment?.pdsEndpoint).toBeUndefined()
    expect(enrollment?.enrollmentRkey).toBeUndefined()
    expect(enrollment?.isService).toBe(false)
  })

  it('updateEnrollment updates each field independently', async () => {
    await store.enroll({
      did: USER_DID,
      enrolledAt: '2025-01-01T00:00:00Z',
      pdsEndpoint: 'https://pds.example.com',
      signingKeyDid: 'did:key:zDnaeUserKey',
      active: true,
      enrollmentRkey: '3kabc',
    })

    await store.updateEnrollment(USER_DID, {
      enrolledAt: '2025-06-01T00:00:00Z',
      pdsEndpoint: 'https://new-pds.example.com',
      signingKeyDid: 'did:key:zDnaeRotated',
      active: false,
      enrollmentRkey: '3kxyz',
      isService: true,
    })

    expect(await store.getEnrollment(USER_DID)).toEqual({
      did: USER_DID,
      enrolledAt: '2025-06-01T00:00:00Z',
      pdsEndpoint: 'https://new-pds.example.com',
      signingKeyDid: 'did:key:zDnaeRotated',
      active: false,
      enrollmentRkey: '3kxyz',
      isService: true,
    })

    // Untouched fields remain after a partial update.
    await store.updateEnrollment(USER_DID, { active: true })
    const partial = await store.getEnrollment(USER_DID)
    expect(partial?.active).toBe(true)
    expect(partial?.signingKeyDid).toBe('did:key:zDnaeRotated')
    expect(partial?.pdsEndpoint).toBe('https://new-pds.example.com')
    expect(partial?.enrollmentRkey).toBe('3kxyz')
  })

  it('listEnrollments returns all rows mapped and respects limit', async () => {
    await store.enroll({
      did: USER_DID,
      enrolledAt: '2025-01-01T00:00:00Z',
      pdsEndpoint: 'https://pds.example.com',
      signingKeyDid: 'did:key:zDnaeUserKey',
      active: true,
      enrollmentRkey: '3kuser',
    })
    await store.enroll({
      did: SERVICE_DID,
      enrolledAt: '2025-01-02T00:00:00Z',
      signingKeyDid: SERVICE_DID,
      active: false,
    })
    await store.updateEnrollment(SERVICE_DID, { isService: true })

    const all = await store.listEnrollments()
    expect(all).toHaveLength(2)

    const user = all.find((e) => e.did === USER_DID)
    expect(user).toEqual({
      did: USER_DID,
      enrolledAt: '2025-01-01T00:00:00Z',
      pdsEndpoint: 'https://pds.example.com',
      signingKeyDid: 'did:key:zDnaeUserKey',
      active: true,
      enrollmentRkey: '3kuser',
      isService: false,
    })
    const service = all.find((e) => e.did === SERVICE_DID)
    expect(service?.active).toBe(false)
    expect(service?.pdsEndpoint).toBeUndefined()
    expect(service?.enrollmentRkey).toBeUndefined()
    expect(service?.isService).toBe(true)

    const limited = await store.listEnrollments({ limit: 1 })
    expect(limited).toHaveLength(1)
  })

  it('listServiceEnrollments maps fields and respects limit', async () => {
    await store.enroll({
      did: SERVICE_DID,
      enrolledAt: '2025-01-02T00:00:00Z',
      signingKeyDid: SERVICE_DID,
      active: true,
      enrollmentRkey: '3ksvc',
    })
    await store.updateEnrollment(SERVICE_DID, { isService: true })

    const otherServiceDid = 'did:web:wille.example.com'
    await store.enroll({
      did: otherServiceDid,
      enrolledAt: '2025-01-03T00:00:00Z',
      signingKeyDid: otherServiceDid,
      active: true,
    })
    await store.updateEnrollment(otherServiceDid, { isService: true })

    const services = await store.listServiceEnrollments()
    expect(services).toHaveLength(2)
    const svc = services.find((e) => e.did === SERVICE_DID)
    expect(svc).toEqual({
      did: SERVICE_DID,
      enrolledAt: '2025-01-02T00:00:00Z',
      pdsEndpoint: undefined,
      signingKeyDid: SERVICE_DID,
      active: true,
      enrollmentRkey: '3ksvc',
      isService: true,
    })

    const limited = await store.listServiceEnrollments({ limit: 1 })
    expect(limited).toHaveLength(1)
  })
})

describe('enrollment isService migration', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-enrollment-migration-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('adds isService to a pre-existing enrollment table without data loss', async () => {
    const db = createServiceDb(join(testDir, 'service.sqlite'))

    // Simulate a legacy database that predates the isService column.
    await db.run(sql`
      CREATE TABLE enrollment (
        did TEXT PRIMARY KEY,
        enrolledAt TEXT NOT NULL,
        pdsEndpoint TEXT,
        signingKeyDid TEXT NOT NULL,
        active TEXT NOT NULL DEFAULT 'true',
        enrollmentRkey TEXT
      )
    `)
    await db.run(sql`
      INSERT INTO enrollment (did, enrolledAt, pdsEndpoint, signingKeyDid, active)
      VALUES (${USER_DID}, '2024-12-01T00:00:00Z', 'https://pds.example.com', 'did:key:zDnaeLegacy', 'true')
    `)

    // Migrating must be idempotent and preserve existing data.
    await migrateServiceDb(db)
    await migrateServiceDb(db)

    const store = new SqliteEnrollmentStore(db)
    const enrollment = await store.getEnrollment(USER_DID)
    expect(enrollment).not.toBeNull()
    expect(enrollment?.isService).toBe(false)
    expect(enrollment?.enrolledAt).toBe('2024-12-01T00:00:00Z')
    expect(enrollment?.pdsEndpoint).toBe('https://pds.example.com')
  })
})

describe('SqliteEnrollmentStore removeBoundary', () => {
  const RYOKO_DID = 'did:plc:ryokohakubi'
  const AYEKA_DID = 'did:plc:ayekajurai'

  let testDir: string
  let store: SqliteEnrollmentStore

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-enrollment-boundary-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })
    const db = createServiceDb(join(testDir, 'service.sqlite'))
    await migrateServiceDb(db)
    store = new SqliteEnrollmentStore(db)

    for (const did of [RYOKO_DID, AYEKA_DID]) {
      await store.enroll({
        did,
        enrolledAt: '2025-02-01T00:00:00Z',
        pdsEndpoint: 'https://pds.jurai.example.com',
        signingKeyDid: 'did:key:zDnaeJuraiKey',
        active: true,
        boundaries: ['galaxy-police', 'jurai-royals'],
      })
    }
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('removes only the named boundary of the named DID', async () => {
    await store.removeBoundary(RYOKO_DID, 'galaxy-police')

    expect(await store.getBoundaries(RYOKO_DID)).toEqual(['jurai-royals'])
    expect((await store.getBoundaries(AYEKA_DID)).toSorted()).toEqual([
      'galaxy-police',
      'jurai-royals',
    ])
  })
})
