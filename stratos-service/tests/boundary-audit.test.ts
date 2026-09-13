import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { Secp256k1Keypair, verifySignature } from '@atproto/crypto'
import type { StoredEnrollment } from '@northskysocial/stratos-core'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from '../src/db/index.js'
import { SqliteEnrollmentStore } from '../src/storage/sqlite/enrollment-store.js'
import {
  AuditedEnrollmentStore,
  BoundaryAudit,
  migrateBoundaryAudit,
  SqliteBoundaryAuditBackend,
  sqliteAuditSql,
} from '../src/features/boundary-audit/index.js'
import {
  boundaryHash,
  boundaryPayload,
  readBoundaryState,
  BoundaryHistoryTruncatedError,
  decodeBoundaryCursor,
  encodeBoundaryCursor,
  verifyBoundaryOperation,
} from '../src/features/boundary-audit/model.js'

const DID = 'did:plc:rei'
const AUTHORITY = 'did:web:nerv.example'
const PILOTS = `${AUTHORITY}/pilots`
const COMMAND = `${AUTHORITY}/command`
const enrollment = (
  overrides: Partial<StoredEnrollment> = {},
): StoredEnrollment => ({
  did: DID,
  active: true,
  enrolledAt: '2026-09-12T00:00:00.000Z',
  signingKeyDid: 'did:key:zRei',
  custody: 'pds',
  boundaries: [PILOTS],
  ...overrides,
})

describe('authority-signed boundary audit', () => {
  let directory: string
  let db: ServiceDb
  let audit: BoundaryAudit
  let store: AuditedEnrollmentStore
  let signer: {
    publicKey: string
    sign: ReturnType<typeof vi.fn<(bytes: Uint8Array) => Promise<Uint8Array>>>
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'stratos-boundary-audit-'))
    db = createServiceDb(join(directory, 'service.sqlite'))
    await migrateServiceDb(db)
    await migrateBoundaryAudit(sqliteAuditSql(db))
    audit = new BoundaryAudit(AUTHORITY, new SqliteBoundaryAuditBackend(db))
    const key = await Secp256k1Keypair.create()
    signer = {
      publicKey: key.did(),
      sign: vi.fn((bytes: Uint8Array) => key.sign(bytes)),
    }
    audit.setSigner(signer)
    store = new AuditedEnrollmentStore(new SqliteEnrollmentStore(db), audit)
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(directory, { recursive: true, force: true })
  })

  it('sequences every membership path, including inactive and deleted enrollments', async () => {
    await store.enroll(enrollment())
    await store.addBoundary(DID, COMMAND)
    await store.setBoundaries(DID, [COMMAND])
    await store.updateEnrollment(DID, { active: false })
    await store.removeBoundary(DID, COMMAND)
    await store.unenroll(DID)
    const page = await audit.list(DID)
    expect(page.operations).toHaveLength(6)
    expect(page.hasMore).toBe(false)
    expect(page.operations.map(({ operation }) => operation.after)).toEqual([
      { enrolled: true, active: true, boundaries: [PILOTS] },
      { enrolled: true, active: true, boundaries: [COMMAND, PILOTS] },
      { enrolled: true, active: true, boundaries: [COMMAND] },
      { enrolled: true, active: false, boundaries: [COMMAND] },
      { enrolled: true, active: false, boundaries: [] },
      { enrolled: false, active: false, boundaries: [] },
    ])
    for (const [index, entry] of page.operations.entries()) {
      expect(entry.operation).toMatchObject({
        $type: 'zone.stratos.boundary.operation',
        authority: AUTHORITY,
        did: DID,
        sequence: index + 1,
        previousHash: index ? page.operations[index - 1].hash : '',
        signingKey: signer.publicKey,
      })
      expect(Number.isNaN(Date.parse(entry.operation.recordedAt))).toBe(false)
      expect(await verifyBoundaryOperation(entry)).toBe(true)
      expect(entry.operation.before).toEqual(
        index
          ? page.operations[index - 1].operation.after
          : { enrolled: false, active: false, boundaries: [] },
      )
    }
    expect((await audit.list(DID, 50, page.cursor)).operations).toEqual([])
  })

  it('does not sign unchanged membership, including metadata updates and retries', async () => {
    await store.enroll(enrollment())
    signer.sign.mockClear()
    await store.enroll(enrollment())
    await store.addBoundary(DID, PILOTS)
    await store.removeBoundary(DID, COMMAND)
    await store.setBoundaries(DID, [PILOTS, PILOTS])
    await store.updateEnrollment(DID, {
      pdsEndpoint: 'https://rei.example',
      active: true,
    })
    expect(signer.sign).not.toHaveBeenCalled()
    expect((await audit.list(DID)).operations).toHaveLength(1)
    expect((await store.getEnrollment(DID))?.pdsEndpoint).toBe(
      'https://rei.example',
    )
  })

  it('updates metadata and replacement boundaries together and skips equivalent retries', async () => {
    await store.enroll(enrollment())
    await store.updateEnrollment(DID, {
      boundaries: [COMMAND, COMMAND],
      active: false,
    })
    expect(await store.getBoundaries(DID)).toEqual([COMMAND])
    expect((await audit.list(DID)).operations[1].operation.after).toEqual({
      enrolled: true,
      active: false,
      boundaries: [COMMAND],
    })
    signer.sign.mockClear()
    await store.updateEnrollment(DID, { boundaries: [COMMAND] })
    expect(signer.sign).not.toHaveBeenCalled()
    await store.updateEnrollment(DID, { boundaries: [] })
    expect(await store.getBoundaries(DID)).toEqual([])
    expect((await audit.list(DID)).operations).toHaveLength(3)
  })

  it('rolls metadata and boundaries back together when signing fails', async () => {
    await store.enroll(enrollment())
    signer.sign.mockRejectedValueOnce(new Error('signing unavailable'))
    await expect(
      store.updateEnrollment(DID, { boundaries: [COMMAND], active: false }),
    ).rejects.toThrow('signing unavailable')
    expect(await store.getBoundaries(DID)).toEqual([PILOTS])
    expect((await store.getEnrollment(DID))?.active).toBe(true)
  })

  it('rejects an unadvanced head and rolls back both membership and operation', async () => {
    await store.enroll(enrollment())
    await db.run(
      sql`CREATE TRIGGER head_test_failure BEFORE UPDATE ON boundary_audit_head BEGIN SELECT RAISE(IGNORE); END`,
    )
    await expect(store.removeBoundary(DID, PILOTS)).rejects.toThrow(
      'Boundary audit head changed during mutation',
    )
    expect(await store.getBoundaries(DID)).toEqual([PILOTS])
    expect((await audit.list(DID)).operations).toHaveLength(1)
  })

  it.each([
    ['$type', 'zone.stratos.boundary.checkpoint'],
    ['authority', 'did:web:seele.example'],
    ['did', 'did:plc:asuka'],
    ['sequence', 2],
    ['previousHash', 'a'.repeat(64)],
  ])(
    'rejects validly signed operations with an inconsistent %s',
    async (field, value) => {
      await store.enroll(enrollment())
      const [{ operation }] = (await audit.list(DID)).operations
      Object.assign(operation, { [field]: value })
      const bytes = boundaryPayload(operation)
      const hash = boundaryHash(bytes)
      const signature = Buffer.from(await signer.sign(bytes)).toString('base64')
      await db.run(
        sql`UPDATE boundary_audit_operation SET operation = ${JSON.stringify(operation)}, hash = ${hash}, signature = ${signature} WHERE did = ${DID}`,
      )
      await db.run(
        sql`UPDATE boundary_audit_head SET hash = ${hash}, sequence = ${operation.sequence} WHERE did = ${DID}`,
      )
      await expect(audit.list(DID)).rejects.toThrow(
        BoundaryHistoryTruncatedError,
      )
    },
  )

  it.each(['null', '42'])(
    'rejects invalid persisted operation JSON %s',
    async (value) => {
      await store.enroll(enrollment())
      await db.run(
        sql`UPDATE boundary_audit_operation SET operation = ${value} WHERE did = ${DID}`,
      )
      await expect(audit.list(DID)).rejects.toThrow(
        BoundaryHistoryTruncatedError,
      )
    },
  )

  it('rejects a changed hash even with a valid signature, and malformed keys', async () => {
    await store.enroll(enrollment())
    const [entry] = (await audit.list(DID)).operations
    expect(
      await verifyBoundaryOperation({ ...entry, hash: 'a'.repeat(64) }),
    ).toBe(false)
    entry.operation.signingKey = 'invalid'
    entry.hash = boundaryHash(boundaryPayload(entry.operation))
    expect(await verifyBoundaryOperation(entry)).toBe(false)
  })

  it('sorts and deduplicates stored boundary state without changing the source array', async () => {
    const boundaries = [PILOTS, COMMAND, PILOTS]
    const raw = new SqliteEnrollmentStore(db)
    vi.spyOn(raw, 'getBoundaries').mockResolvedValue(boundaries)
    expect((await readBoundaryState(raw, DID)).boundaries).toEqual([
      COMMAND,
      PILOTS,
    ])
    expect(boundaries).toEqual([PILOTS, COMMAND, PILOTS])
  })

  it('accepts the maximum page size', async () => {
    expect((await audit.list(DID, 100)).operations).toEqual([])
  })

  it('captures the actual stored baseline for an enrollment predating audit', async () => {
    await new SqliteEnrollmentStore(db).enroll(enrollment({ active: false }))
    await store.addBoundary(DID, COMMAND)
    const [{ operation }] = (await audit.list(DID)).operations
    expect(operation.before).toEqual({
      enrolled: true,
      active: false,
      boundaries: [PILOTS],
    })
    expect(operation.after.boundaries).toEqual([COMMAND, PILOTS])
  })

  it('rolls membership back when signing fails and retries without a gap', async () => {
    await store.enroll(enrollment())
    signer.sign.mockRejectedValueOnce(new Error('signing unavailable'))
    await expect(store.setBoundaries(DID, [COMMAND])).rejects.toThrow(
      'signing unavailable',
    )
    expect(await store.getBoundaries(DID)).toEqual([PILOTS])
    expect((await audit.list(DID)).operations).toHaveLength(1)
    await store.setBoundaries(DID, [COMMAND])
    expect(
      (await audit.list(DID)).operations.map(
        ({ operation }) => operation.sequence,
      ),
    ).toEqual([1, 2])
  })

  it('rolls membership back when history persistence fails', async () => {
    await store.enroll(enrollment())
    await db.run(
      sql`CREATE TRIGGER audit_test_failure BEFORE INSERT ON boundary_audit_operation BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
    )
    await expect(store.unenroll(DID)).rejects.toThrow('persist boundary audit')
    expect(await store.isEnrolled(DID)).toBe(true)
    expect(await store.getBoundaries(DID)).toEqual([PILOTS])
    await db.run(sql`DROP TRIGGER audit_test_failure`)
    await store.unenroll(DID)
    expect((await audit.list(DID)).operations).toHaveLength(2)
  })

  it('rolls history back when the membership write fails', async () => {
    await store.enroll(enrollment())
    await db.run(
      sql`CREATE TRIGGER membership_test_failure BEFORE INSERT ON enrollment_boundary WHEN NEW.boundary = 'did:web:nerv.example/command' BEGIN SELECT RAISE(ABORT, 'inactive boundary'); END`,
    )
    await expect(store.setBoundaries(DID, [COMMAND])).rejects.toThrow()
    expect(await store.getBoundaries(DID)).toEqual([PILOTS])
    expect((await audit.list(DID)).operations).toHaveLength(1)
  })

  it('serializes concurrent mutations and duplicate joins in the real database', async () => {
    await store.enroll(enrollment())
    await Promise.all([
      store.addBoundary(DID, COMMAND),
      store.addBoundary(DID, COMMAND),
      store.addBoundary(DID, `${AUTHORITY}/science`),
    ])
    const page = await audit.list(DID)
    expect(page.operations.map(({ operation }) => operation.sequence)).toEqual([
      1, 2, 3,
    ])
    expect(page.operations[2].operation.previousHash).toBe(
      page.operations[1].hash,
    )
    expect(await store.getBoundaries(DID)).toEqual([
      COMMAND,
      PILOTS,
      `${AUTHORITY}/science`,
    ])
  })

  it('pages history without mixing actors and preserves the last cursor for polling', async () => {
    await store.enroll(enrollment())
    await store.enroll(enrollment({ did: 'did:plc:asuka' }))
    await store.addBoundary(DID, COMMAND)
    const first = await audit.list(DID, 1)
    expect(first.hasMore).toBe(true)
    const second = await audit.list(DID, 1, first.cursor)
    expect(second.operations[0].operation.sequence).toBe(2)
    expect(second.hasMore).toBe(false)
    await expect(audit.list('did:plc:asuka', 1, first.cursor)).rejects.toThrow(
      BoundaryHistoryTruncatedError,
    )
    const empty = await audit.list(DID, 1, second.cursor)
    expect(empty).toEqual({
      operations: [],
      cursor: second.cursor,
      hasMore: false,
    })
  })

  it('returns a signed consistent recovery checkpoint and resumes after pruning', async () => {
    await store.enroll(enrollment())
    await store.updateEnrollment(DID, { active: false })
    const snapshot = await audit.checkpoint(DID)
    expect(snapshot.checkpoint).toMatchObject({
      $type: 'zone.stratos.boundary.checkpoint',
      authority: AUTHORITY,
      did: DID,
      sequence: 2,
      signingKey: signer.publicKey,
      state: { enrolled: true, active: false, boundaries: [PILOTS] },
    })
    expect(
      await verifySignature(
        signer.publicKey,
        boundaryPayload(snapshot.checkpoint),
        Buffer.from(snapshot.signature, 'base64'),
      ),
    ).toBe(true)
    await db.run(sql`DELETE FROM boundary_audit_operation WHERE did = ${DID}`)
    await expect(audit.list(DID)).rejects.toThrow(BoundaryHistoryTruncatedError)
    await store.removeBoundary(DID, PILOTS)
    const page = await audit.list(DID, 50, snapshot.cursor)
    expect(page.operations[0].operation.sequence).toBe(3)
    expect(page.operations[0].operation.previousHash).toBe(
      snapshot.checkpoint.headHash,
    )
  })

  it('fails closed when a retained window has a missing operation', async () => {
    await store.enroll(enrollment())
    await store.addBoundary(DID, COMMAND)
    await store.removeBoundary(DID, PILOTS)
    await db.run(
      sql`DELETE FROM boundary_audit_operation WHERE did = ${DID} AND sequence = 2`,
    )
    await expect(audit.list(DID)).rejects.toThrow(BoundaryHistoryTruncatedError)
  })

  it.each(['hash', 'signature', 'operation'] as const)(
    'fails closed on corrupted %s',
    async (field) => {
      await store.enroll(enrollment())
      await db.run(
        sql`UPDATE boundary_audit_operation SET ${sql.identifier(field)} = 'broken' WHERE did = ${DID}`,
      )
      await expect(audit.list(DID)).rejects.toThrow(
        BoundaryHistoryTruncatedError,
      )
    },
  )

  it('rejects unknown positions and changed head hashes', async () => {
    await store.enroll(enrollment())
    await expect(
      audit.list(DID, 50, encodeBoundaryCursor(DID, 9, 'a'.repeat(64))),
    ).rejects.toThrow(BoundaryHistoryTruncatedError)
    await expect(
      audit.list(DID, 50, encodeBoundaryCursor(DID, 1, 'a'.repeat(64))),
    ).rejects.toThrow(BoundaryHistoryTruncatedError)
    await db.run(
      sql`UPDATE boundary_audit_head SET hash = 'bad' WHERE did = ${DID}`,
    )
    await expect(audit.list(DID)).rejects.toThrow(BoundaryHistoryTruncatedError)
  })

  it('starts an empty checkpoint at sequence zero and does not fabricate an enrollment', async () => {
    const snapshot = await audit.checkpoint(DID)
    expect(snapshot.checkpoint).toMatchObject({
      sequence: 0,
      headHash: '',
      state: { enrolled: false, active: false, boundaries: [] },
    })
    expect(await audit.list(DID, 50, snapshot.cursor)).toEqual({
      operations: [],
      cursor: snapshot.cursor,
      hasMore: false,
    })
  })

  it('fails before a write if the authority signer is not initialized', async () => {
    const uninitialized = new BoundaryAudit(
      AUTHORITY,
      new SqliteBoundaryAuditBackend(db),
    )
    const mutation = vi.fn()
    await expect(uninitialized.mutate(DID, mutation)).rejects.toThrow(
      'not initialized',
    )
    expect(mutation).not.toHaveBeenCalled()
    await expect(uninitialized.checkpoint(DID)).rejects.toThrow(
      'not initialized',
    )
  })

  it('keeps prior signatures verifiable when the service key changes', async () => {
    await store.enroll(enrollment())
    const nextKey = await Secp256k1Keypair.create()
    audit.setSigner({
      publicKey: nextKey.did(),
      sign: (bytes) => nextKey.sign(bytes),
    })
    await store.addBoundary(DID, COMMAND)
    const entries = (await audit.list(DID)).operations
    expect(entries.map(({ operation }) => operation.signingKey)).toEqual([
      signer.publicKey,
      nextKey.did(),
    ])
    expect(entries[1].operation.previousHash).toBe(entries[0].hash)
  })

  it('forwards enrollment reads and lists through the normal store', async () => {
    await store.enroll(enrollment())
    await store.enroll(
      enrollment({ did: AUTHORITY, isService: true, boundaries: [COMMAND] }),
    )
    expect(await store.enrollmentCount()).toBe(2)
    expect(await store.listEnrollments({ limit: 1 })).toHaveLength(1)
    expect((await store.listServiceEnrollments({ limit: 1 }))[0].did).toBe(
      AUTHORITY,
    )
    expect(
      (await store.listEnrollmentsByBoundary(COMMAND, { limit: 1 }))[0].did,
    ).toBe(AUTHORITY)
  })

  it.each([0, -1, 101, 1.5, NaN, Infinity])(
    'rejects invalid page size %s',
    async (limit) => {
      await expect(audit.list(DID, limit)).rejects.toThrow(
        'limit must be an integer from 1 to 100',
      )
    },
  )
})

describe('boundary history cursors', () => {
  it.each([
    'broken',
    ...[
      null,
      {},
      [],
      [DID, -1, 'a'.repeat(64)],
      ['did:plc:asuka', 0, ''],
      [DID, 1, ['a'.repeat(64)]],
      [DID, 1, 'x' + 'a'.repeat(64)],
      [DID, 1, 'a'.repeat(64) + 'x'],
      [DID, 0, 'unexpected'],
      [DID, 1, 'bad'],
      [DID, 1.5, 'a'.repeat(64)],
      [DID, 1, 2],
      [DID, 1, 'a'.repeat(64), 4],
    ].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')),
  ])('rejects malformed cursor %s', (cursor) => {
    expect(() => decodeBoundaryCursor(DID, cursor)).toThrow(
      'Boundary history cannot prove this cursor; recover a signed checkpoint',
    )
  })
})
