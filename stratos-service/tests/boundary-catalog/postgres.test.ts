import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { sql } from 'drizzle-orm'
import {
  createServicePgDb,
  migrateServicePgDb,
  closeServicePgDb,
  type ServicePgDb,
} from '../../src/db/pg.js'
import { createPgBoundaryStore } from '../../src/features/boundary/store.js'
import { migratePgBoundaries } from '../../src/features/boundary/migrate.js'
import { initialBoundaryDefinitions } from '../../src/features/boundary/configuration.js'
import { PgEnrollmentStoreWriter } from '../../src/infra/storage/postgres/enrollment-store.js'
import { createTestConfig } from '../utils/index.js'
import { ENGINEERING, SERVICE, settings } from './helpers.js'
import type { BoundaryCatalogStore } from '@northskysocial/stratos-core'

describe('Postgres boundary catalog', () => {
  let container: StartedPostgreSqlContainer | undefined
  let db: ServicePgDb
  let otherDb: ServicePgDb
  let store: BoundaryCatalogStore
  beforeAll(async () => {
    const connection = process.env.BOUNDARY_TEST_POSTGRES_URL
    if (!connection)
      container = await new PostgreSqlContainer('postgres:18-alpine').start()
    const url = connection ?? container!.getConnectionUri()
    db = createServicePgDb(url)
    otherDb = createServicePgDb(url)
    await migrateServicePgDb(db)
    // External mutation databases are reused, but migration tests need an empty catalog.
    await db.execute(
      sql`DROP TABLE IF EXISTS boundary_catalog_state, boundary_definition, boundary_deactivation_member CASCADE`,
    )
    await db.execute(
      sql`DROP FUNCTION IF EXISTS stratos_guard_boundary_membership() CASCADE`,
    )
    await migratePgBoundaries(db)
    await migratePgBoundaries(db)
    await db.execute(
      sql`TRUNCATE boundary_catalog_state, boundary_definition, boundary_deactivation_member, enrollment_boundary, enrollment`,
    )
    store = createPgBoundaryStore(db)
    const cfg = createTestConfig('/tmp/stratos-boundary-test')
    cfg.service.did = SERVICE
    await store.initialize(initialBoundaryDefinitions(cfg))
  }, 120_000)
  afterAll(async () => {
    if (db) await closeServicePgDb(db)
    if (otherDb) await closeServicePgDb(otherDb)
    await container?.stop()
  })
  it('persists definitions, optimistic revisions, queues, and irreversible removal', async () => {
    const raw = new PgEnrollmentStoreWriter(db)
    const did = 'did:plc:spike'
    await raw.enroll({
      did,
      active: true,
      enrolledAt: new Date().toISOString(),
      signingKeyDid: 'did:key:spike',
      boundaries: [ENGINEERING],
    })
    expect(await store.countMembers(ENGINEERING)).toBe(1)
    expect(await store.update(ENGINEERING, settings, 1)).toBe(true)
    expect(await store.update(ENGINEERING, settings, 1)).toBe(false)
    expect(await store.beginDeactivation(ENGINEERING, 2)).toBe(true)
    expect(await store.listDeactivationMembers(ENGINEERING, 1)).toEqual([did])
    expect(await store.finishDeactivation(ENGINEERING)).toBe(false)
    await expect(raw.addBoundary('did:plc:faye', ENGINEERING)).rejects.toThrow()
    await raw.removeBoundary(did, ENGINEERING)
    expect(await store.finishDeactivation(ENGINEERING)).toBe(false)
    await store.completeDeactivationMember(ENGINEERING, did)
    expect(await store.finishDeactivation(ENGINEERING)).toBe(true)
    expect(await store.reactivate(ENGINEERING, 4)).toBe(true)
    expect(await store.countMembers(ENGINEERING)).toBe(0)
    const reopened = createPgBoundaryStore(otherDb)
    await reopened.initialize([])
    expect(await reopened.list()).toHaveLength(3)
    expect(await reopened.get(ENGINEERING)).toMatchObject({
      ...settings,
      status: 'active',
      revision: 5,
    })
    expect(await reopened.get('missing')).toBeNull()
    const source = (await reopened.get(ENGINEERING))!
    await reopened.create({
      ...source,
      boundary: `${SERVICE}/bebop`,
      roomId: 'bebop',
    })
    expect(await store.get(`${SERVICE}/bebop`)).toMatchObject({
      roomId: 'bebop',
    })
  })
  it('waits for a concurrent grant and includes it in the durable deactivation workset', async () => {
    let granted!: () => void
    let release!: () => void
    const grantReady = new Promise<void>((r) => {
      granted = r
    })
    const releaseGrant = new Promise<void>((r) => {
      release = r
    })
    const pendingGrant = otherDb.transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO enrollment_boundary (did,boundary) VALUES ('did:plc:jet',${ENGINEERING})`,
      )
      granted()
      await releaseGrant
    })
    await grantReady
    const deactivation = store.beginDeactivation(ENGINEERING, 5)
    release()
    await pendingGrant
    expect(await deactivation).toBe(true)
    expect(await store.listDeactivationMembers(ENGINEERING, 100)).toEqual([
      'did:plc:jet',
    ])
    await expect(
      otherDb.execute(
        sql`INSERT INTO enrollment_boundary (did,boundary) VALUES ('did:plc:ed',${ENGINEERING})`,
      ),
    ).rejects.toThrow()
  })
})
