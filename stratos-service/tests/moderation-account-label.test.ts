import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from '@atcute/cbor'
import { Secp256k1Keypair } from '@atproto/crypto'
import {
  ACCOUNT_SUBJECT_TYPE,
  computeCid,
  encodeRecord,
  parseCid,
} from '@northskysocial/stratos-core'
import { StratosActorStore } from '../src/context.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from '../src/db/index.js'
import {
  AuditedEnrollmentStore,
  BoundaryAudit,
  migrateBoundaryAudit,
  SqliteBoundaryAuditBackend,
  sqliteAuditSql,
} from '../src/features/boundary-audit/index.js'
import { ActiveBoundaryEnrollmentStore } from '../src/features/boundary/enrollment-store.js'
import { migrateSqliteBoundaries } from '../src/features/boundary/migrate.js'
import { createSqliteBoundaryStore } from '../src/features/boundary/store.js'
import { SqliteLabelStore } from '../src/features/moderation/index.js'
import { SqlitePdsSyncQueueStore } from '../src/features/enrollment/index.js'
import { ReservedDomainEnrollmentStore } from '../src/infra/storage/reserved-domain-enrollment-store.js'
import { SqliteEnrollmentStore } from '../src/storage/sqlite/enrollment-store.js'
import { createMockBlobStore } from './utils'
import {
  buildAccountLabelHarness,
  buildSetActiveHarness,
  defineAccountLabelScenarios,
  FAYE_DID,
  GEOFRONT_BOUNDARY,
  RESERVED_BOUNDARY,
  rowOf,
  seedAccount,
  seedBoundaryCatalog,
  SPIKE_DID,
  type AccountLabelHarness,
  type HoldsBackend,
} from './helpers/enrollment-holds.js'
import { expectNoEntryContains, logsDuring } from './helpers/log-capture.js'

const POST_COLLECTION = 'zone.stratos.feed.post'

describe('account subjects in createLabel on SQLite', () => {
  let tmp: string
  let db: ServiceDb
  let backend: HoldsBackend
  let harness: AccountLabelHarness

  // The decorator chain createStorageContext builds for SQLite.
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'stratos-account-label-'))
    const dbPath = join(tmp, 'service.sqlite')
    db = createServiceDb(dbPath)
    await migrateServiceDb(db)
    await migrateSqliteBoundaries(db)
    const catalog = createSqliteBoundaryStore(db)
    await seedBoundaryCatalog(catalog)
    await migrateBoundaryAudit(sqliteAuditSql(db))
    const audit = new BoundaryAudit(
      'did:web:bebop.example',
      new SqliteBoundaryAuditBackend(db),
    )
    const auditKey = await Secp256k1Keypair.create()
    audit.setSigner({
      publicKey: auditKey.did(),
      sign: (bytes) => auditKey.sign(bytes),
    })
    backend = {
      enrollmentStore: new ActiveBoundaryEnrollmentStore(
        new ReservedDomainEnrollmentStore(
          new AuditedEnrollmentStore(new SqliteEnrollmentStore(db), audit),
          RESERVED_BOUNDARY,
        ),
        catalog,
      ),
      labelStore: new SqliteLabelStore(db, dbPath),
      pdsSyncQueue: new SqlitePdsSyncQueueStore(db),
    }
    harness = await buildAccountLabelHarness(backend)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await harness.close()
    await closeServiceDb(db)
    rmSync(tmp, { recursive: true, force: true })
  })

  defineAccountLabelScenarios(() => backend)

  it('refuses setActive true during a takedown', async () => {
    const { setActive } = buildSetActiveHarness(backend)
    await seedAccount(backend, { did: SPIKE_DID })
    await harness.takedown(SPIKE_DID)

    const res = await setActive(SPIKE_DID, true)

    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ error: 'AccountTakenDown' })
    expect((await rowOf(backend, SPIKE_DID))?.active).toBe(false)
  })

  it('appends nothing when the member is unenrolled between the check and the deactivation', async () => {
    await seedAccount(backend, { did: SPIKE_DID })
    const readEnrollment = backend.enrollmentStore.getEnrollment.bind(
      backend.enrollmentStore,
    )
    let reads = 0
    vi.spyOn(backend.enrollmentStore, 'getEnrollment').mockImplementation(
      async (did) => {
        reads += 1
        if (reads === 2) await backend.enrollmentStore.unenroll(did)
        return readEnrollment(did)
      },
    )

    const res = await harness.takedown(SPIKE_DID)

    expect(reads).toBeGreaterThanOrEqual(2)
    expect(res.status).toBe(400)
    expect(res.data.error).toBe('SubjectNotFound')
    expect(await harness.labels()).toEqual([])
    expect(await rowOf(backend, SPIKE_DID)).toBeNull()
  })

  it('treats a repeat takedown with the same ref as a no-op and a new ref as a new label', async () => {
    await seedAccount(backend, { did: SPIKE_DID })
    await harness.takedown(SPIKE_DID, { ref: 'case-0100' })
    const afterFirst = await rowOf(backend, SPIKE_DID)
    harness.signals.length = 0

    const repeat = await harness.takedown(SPIKE_DID, { ref: 'case-0100' })

    expect(repeat.status).toBe(200)
    expect(await harness.labels()).toHaveLength(1)
    expect(await rowOf(backend, SPIKE_DID)).toEqual(afterFirst)
    expect(harness.signals).toEqual([])

    const other = await harness.takedown(SPIKE_DID, { ref: 'case-0200' })

    expect(other.status).toBe(200)
    expect((await harness.labels()).map((label) => label.ref)).toEqual([
      'case-0100',
      'case-0200',
    ])
    const row = await rowOf(backend, SPIKE_DID)
    expect(row?.active).toBe(false)
    expect(row?.operatorHold).toBe(false)
  })

  it('appends nothing for a negation with no label, and keeps the member state', async () => {
    const { setActive } = buildSetActiveHarness(backend)
    await seedAccount(backend, { did: SPIKE_DID })
    await seedAccount(backend, { did: FAYE_DID })
    await setActive(FAYE_DID, false)
    const heldBefore = await rowOf(backend, FAYE_DID)
    harness.signals.length = 0

    const active = await harness.negate(SPIKE_DID)
    const held = await harness.negate(FAYE_DID)

    expect(active.status).toBe(200)
    expect(held.status).toBe(200)
    expect(await harness.labels()).toEqual([])
    const spike = await rowOf(backend, SPIKE_DID)
    expect(spike?.active).toBe(true)
    expect(await rowOf(backend, FAYE_DID)).toEqual(heldBefore)
    expect(harness.signals).toEqual([])
  })

  it('appends nothing when a negation fails to reactivate the member, and a retry reactivates it', async () => {
    await seedAccount(backend, { did: SPIKE_DID })
    await harness.takedown(SPIKE_DID)
    vi.spyOn(backend.enrollmentStore, 'updateEnrollment').mockRejectedValueOnce(
      new Error('enrollment write unavailable'),
    )

    const failed = await harness.negate(SPIKE_DID)

    expect(failed.status).toBe(500)
    expect(await harness.labels()).toHaveLength(1)
    expect((await rowOf(backend, SPIKE_DID))?.active).toBe(false)

    const retry = await harness.negate(SPIKE_DID)

    expect(retry.status).toBe(200)
    expect(await harness.labels()).toHaveLength(2)
    expect((await rowOf(backend, SPIKE_DID))?.active).toBe(true)
  })

  it('leaves the hosted record marker untouched by an account takedown', async () => {
    const actorStore = new StratosActorStore({
      dataDir: tmp,
      blobstore: () => createMockBlobStore(),
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })
    await seedAccount(backend, { did: SPIKE_DID })
    await actorStore.create(SPIKE_DID)
    const uri = `at://${SPIKE_DID}/${POST_COLLECTION}/bebop`
    const body = { $type: POST_COLLECTION, text: 'See you space cowboy' }
    const cid = parseCid((await computeCid(body)).toString())
    await actorStore.transact(SPIKE_DID, (store) =>
      store.record.putRecord({
        uri,
        cid,
        value: body,
        content: encodeRecord(body),
      }),
    )

    const res = await harness.takedown(SPIKE_DID)

    expect(res.status).toBe(200)
    const marker = await actorStore.read(SPIKE_DID, (store) =>
      store.record.getRecordTakedownStatus(uri),
    )
    expect(marker === null || marker.applied === false).toBe(true)
  })

  it('changes nothing while a negation waits on the member lock', async () => {
    await seedAccount(backend, { did: SPIKE_DID })
    await harness.takedown(SPIKE_DID)
    const release = await harness.ctx.repoWriteLocks.acquire(SPIKE_DID)
    const acquire = vi.spyOn(harness.ctx.repoWriteLocks, 'acquire')

    const pending = harness.negate(SPIKE_DID)
    try {
      await vi.waitFor(() => expect(acquire).toHaveBeenCalledWith(SPIKE_DID))
      expect(await harness.labels()).toHaveLength(1)
      expect((await rowOf(backend, SPIKE_DID))?.active).toBe(false)
    } finally {
      release()
    }

    const res = await pending
    expect(res.status).toBe(200)
    expect(await harness.labels()).toHaveLength(2)
    expect((await rowOf(backend, SPIKE_DID))?.active).toBe(true)
  })

  it('serves the account label to a moderator and to a service sharing a boundary', async () => {
    await seedAccount(backend, { did: SPIKE_DID })
    await seedAccount(backend, { did: harness.serviceDid, isService: true })
    await harness.takedown(SPIKE_DID, { ref: 'case-0100' })

    const asModerator = await harness.queryAsModerator()
    const asService = await harness.queryAsService()

    for (const res of [asModerator, asService]) {
      expect(res.status).toBe(200)
      expect(res.data.labels).toHaveLength(1)
      expect(res.data.labels[0]).toMatchObject({
        subject: {
          $type: 'zone.stratos.moderation.defs#accountSubject',
          did: SPIKE_DID,
        },
        val: '!takedown',
        ref: 'case-0100',
      })
    }
  })

  it('hides the account label from a service that shares no boundary with the member', async () => {
    await seedAccount(backend, { did: SPIKE_DID })
    await seedAccount(backend, {
      did: harness.serviceDid,
      isService: true,
      boundaries: [GEOFRONT_BOUNDARY],
    })
    await harness.takedown(SPIKE_DID)

    const res = await harness.queryAsService()

    expect(res.status).toBe(200)
    expect(res.data.labels).toEqual([])
  })

  it('logs one business event per appended label', async () => {
    await seedAccount(backend, { did: SPIKE_DID })

    await harness.takedown(SPIKE_DID, { ref: 'case-0100' })
    await harness.takedown(SPIKE_DID, { ref: 'case-0100' })
    await harness.negate(SPIKE_DID)

    const appended = vi
      .mocked(harness.ctx.logger?.info as never as (...a: unknown[]) => void)
      .mock.calls.filter((call) => call[1] === 'moderation label appended')
    expect(appended).toHaveLength(2)
    expect(appended[0][0]).toEqual({
      seq: expect.any(Number),
      neg: false,
      subjectKind: 'account',
      callerDid: harness.moderatorDid,
    })
  })

  describe('no log entry names the account or the ref', () => {
    const CASE_REF = 'case-bebop-0042'

    it('an account takedown', async () => {
      await seedAccount(backend, { did: SPIKE_DID })

      const { result, entries } = await logsDuring(harness.ctx.logger!, () =>
        harness.takedown(SPIKE_DID, { ref: CASE_REF }),
      )

      expect(result.status).toBe(200)
      expectNoEntryContains(entries, [SPIKE_DID, CASE_REF])
    })

    it('an account negation', async () => {
      await seedAccount(backend, { did: SPIKE_DID })
      await harness.takedown(SPIKE_DID, { ref: CASE_REF })

      const { result, entries } = await logsDuring(harness.ctx.logger!, () =>
        harness.negate(SPIKE_DID, { ref: CASE_REF }),
      )

      expect(result.status).toBe(200)
      expect(result.data.label.neg).toBe(true)
      expectNoEntryContains(entries, [SPIKE_DID, CASE_REF])
    })

    it('an account takedown whose append fails', async () => {
      await seedAccount(backend, { did: SPIKE_DID })
      vi.spyOn(backend.labelStore, 'appendIfLatest').mockRejectedValueOnce(
        new Error('label log unavailable'),
      )

      const { result, entries } = await logsDuring(harness.ctx.logger!, () =>
        harness.takedown(SPIKE_DID, { ref: CASE_REF }),
      )

      expect(result.status).toBe(500)
      expectNoEntryContains(entries, [SPIKE_DID, CASE_REF])
    })

    it('an append refused for an account with no enrollment', async () => {
      const { result, entries } = await logsDuring(harness.ctx.logger!, () =>
        harness.takedown(FAYE_DID, { ref: CASE_REF }),
      )

      expect(result.data.error).toBe('SubjectNotFound')
      expectNoEntryContains(entries, [FAYE_DID, CASE_REF])
    })
  })

  it('an account subject is untouched by the record cid refusal: a stray cid is ignored', async () => {
    await seedAccount(backend, { did: SPIKE_DID })

    const res = await harness.createLabel({
      subject: {
        $type: ACCOUNT_SUBJECT_TYPE,
        did: SPIKE_DID,
        cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      },
      val: '!takedown',
    })

    expect(res.status).toBe(200)
    expect(res.data.label.subject).toEqual({
      $type: ACCOUNT_SUBJECT_TYPE,
      did: SPIKE_DID,
    })
    const labels = await harness.labels()
    expect(labels).toHaveLength(1)
    expect(labels[0].cid).toBeUndefined()
    expect((await rowOf(backend, SPIKE_DID))?.active).toBe(false)
  })
})
