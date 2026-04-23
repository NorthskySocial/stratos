import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServiceDb } from '../src/db/index.js'
import {
  closeServiceDb,
  createServiceDb,
  enrollmentBoundary,
  migrateServiceDb,
} from '../src/db/index.js'
import { SqliteEnrollmentStore } from '../src/context.js'
import { eq } from 'drizzle-orm'

let db: ServiceDb

describe('Enrollment - auto enroll boundaries', () => {
  beforeEach(async () => {
    db = createServiceDb(':memory:')
    await migrateServiceDb(db)
  })

  afterEach(async () => {
    await closeServiceDb(db)
  })

  it('persists boundaries correctly via SqliteEnrollmentStore', async () => {
    const store = new SqliteEnrollmentStore(db)
    const did = 'did:plc:testauto'
    const boundaries = [
      'did:web:nerv.tokyo.jp/alpha',
      'did:web:nerv.tokyo.jp/beta',
      'did:web:nerv.tokyo.jp/user-boundary',
    ]

    await store.enroll({
      did,
      enrolledAt: new Date().toISOString(),
      boundaries,
      signingKeyDid: 'did:key:zUsagiTsukinoMoon123',
      active: true,
    })

    // Boundaries should be persisted
    const persistedBoundaries = await store.getBoundaries(did)
    expect(persistedBoundaries.sort()).toEqual(boundaries.sort())

    const persisted = await db
      .select({ boundary: enrollmentBoundary.boundary })
      .from(enrollmentBoundary)
      .where(eq(enrollmentBoundary.did, did))

    expect(persisted.map((r) => r.boundary).sort()).toEqual(boundaries.sort())
  })
})
