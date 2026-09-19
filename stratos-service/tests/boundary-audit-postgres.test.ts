import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { Secp256k1Keypair } from '@atproto/crypto'
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import {
  createServicePgDb,
  migrateServicePgDb,
  closeServicePgDb,
  type ServicePgDb,
} from '../src/db/pg.js'
import { PgEnrollmentStoreWriter } from '../src/infra/storage/postgres/enrollment-store.js'
import {
  AuditedEnrollmentStore,
  BoundaryAudit,
  migrateBoundaryAudit,
  PgBoundaryAuditBackend,
  pgAuditSql,
} from '../src/features/boundary-audit/index.js'

describe('Postgres boundary audit transactions', () => {
  let container: StartedPostgreSqlContainer
  let db: ServicePgDb
  let secondDb: ServicePgDb
  let audit: BoundaryAudit
  let secondAudit: BoundaryAudit
  let store: AuditedEnrollmentStore
  let secondStore: AuditedEnrollmentStore
  let signer: {
    publicKey: string
    sign: ReturnType<typeof vi.fn<(bytes: Uint8Array) => Promise<Uint8Array>>>
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').start()
    db = createServicePgDb(container.getConnectionUri())
    secondDb = createServicePgDb(container.getConnectionUri())
    await migrateServicePgDb(db)
    await migrateBoundaryAudit(pgAuditSql(db))
    await migrateBoundaryAudit(pgAuditSql(db))
    const key = await Secp256k1Keypair.create()
    signer = {
      publicKey: key.did(),
      sign: vi.fn((bytes: Uint8Array) => key.sign(bytes)),
    }
    audit = new BoundaryAudit(
      'did:web:nerv.example',
      new PgBoundaryAuditBackend(db),
    )
    secondAudit = new BoundaryAudit(
      'did:web:nerv.example',
      new PgBoundaryAuditBackend(secondDb),
    )
    audit.setSigner(signer)
    secondAudit.setSigner(signer)
    store = new AuditedEnrollmentStore(new PgEnrollmentStoreWriter(db), audit)
    secondStore = new AuditedEnrollmentStore(
      new PgEnrollmentStoreWriter(secondDb),
      secondAudit,
    )
  }, 120_000)

  afterAll(async () => {
    if (db) await closeServicePgDb(db)
    if (secondDb) await closeServicePgDb(secondDb)
    await container?.stop()
  })

  it('serializes writers using independent connections and suppresses duplicate membership', async () => {
    const did = 'did:plc:rei'
    await store.enroll({
      did,
      active: true,
      enrolledAt: new Date().toISOString(),
      signingKeyDid: 'did:key:zRei',
      custody: 'pds',
      boundaries: ['pilots'],
    })
    await Promise.all([
      store.addBoundary(did, 'command'),
      secondStore.addBoundary(did, 'science'),
      secondStore.addBoundary(did, 'command'),
    ])
    const page = await audit.list(did)
    expect(page.operations.map(({ operation }) => operation.sequence)).toEqual([
      1, 2, 3,
    ])
    expect(page.operations[2].operation.before).toEqual(
      page.operations[1].operation.after,
    )
    expect((await store.getBoundaries(did)).sort()).toEqual([
      'command',
      'pilots',
      'science',
    ])
    const snapshot = await secondAudit.checkpoint(did)
    expect(snapshot.checkpoint.headHash).toBe(page.operations[2].hash)
    expect((await audit.list(did, 50, snapshot.cursor)).operations).toEqual([])
  })

  it('rolls enrollment and sequence back on signer failure, then retries', async () => {
    const did = 'did:plc:asuka'
    const record = {
      did,
      active: true,
      enrolledAt: new Date().toISOString(),
      signingKeyDid: 'did:key:zAsuka',
      boundaries: ['pilots'],
    }
    signer.sign.mockRejectedValueOnce(new Error('signer offline'))
    await expect(store.enroll(record)).rejects.toThrow('signer offline')
    expect(await store.getEnrollment(did)).toBeNull()
    expect((await audit.list(did)).operations).toEqual([])
    await secondStore.enroll(record)
    expect((await audit.list(did)).operations[0].operation.sequence).toBe(1)
  })

  it('atomically applies metadata and replacement boundaries and rolls both back on failure', async () => {
    const did = 'did:plc:ritsuko'
    await store.enroll({
      did,
      active: true,
      enrolledAt: new Date().toISOString(),
      signingKeyDid: 'did:key:zRitsuko',
      boundaries: ['science'],
    })
    signer.sign.mockRejectedValueOnce(new Error('signer offline'))
    await expect(
      store.updateEnrollment(did, { active: false, boundaries: ['command'] }),
    ).rejects.toThrow('signer offline')
    expect(await secondStore.getBoundaries(did)).toEqual(['science'])
    expect((await secondStore.getEnrollment(did))?.active).toBe(true)
    await secondStore.updateEnrollment(did, {
      active: false,
      boundaries: ['command'],
    })
    const page = await audit.list(did, 1)
    expect(page.hasMore).toBe(true)
    const next = await secondAudit.list(did, 1, page.cursor)
    expect(next.hasMore).toBe(false)
    expect(next.operations[0].operation.after).toEqual({
      enrolled: true,
      active: false,
      boundaries: ['command'],
    })
  })

  it('preserves membership and chain when persistence fails', async () => {
    const did = 'did:plc:misato'
    await store.enroll({
      did,
      active: true,
      enrolledAt: new Date().toISOString(),
      signingKeyDid: 'did:key:zMisato',
      boundaries: ['command'],
    })
    await db.execute(
      sql`ALTER TABLE boundary_audit_operation ADD CONSTRAINT audit_test_failure CHECK (sequence < 2) NOT VALID`,
    )
    await expect(store.removeBoundary(did, 'command')).rejects.toThrow(
      'persist boundary audit',
    )
    expect(await store.getBoundaries(did)).toEqual(['command'])
    await db.execute(
      sql`ALTER TABLE boundary_audit_operation DROP CONSTRAINT audit_test_failure`,
    )
    await store.removeBoundary(did, 'command')
    expect((await audit.list(did)).operations).toHaveLength(2)
  })
})
