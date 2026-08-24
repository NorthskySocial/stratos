import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createServiceDb, migrateServiceDb, type ServiceDb } from '../src/db'
import { SqliteEnrollmentStore } from '../src/storage/sqlite/enrollment-store.js'
import { ReservedDomainEnrollmentStore } from '../src/infra/storage/reserved-domain-enrollment-store.js'
import { SqlitePdsSyncQueueStore } from '../src/features/enrollment/internal/pds-sync-store.js'
import { syncEnrollmentRecordToPds } from '../src/features/enrollment/internal/pds-enrollment-sync.js'
import { PdsEnrollmentSyncWorker } from '../src/features/enrollment/pds-sync-worker.js'

const USAGI = 'did:plc:usagitsukino'
const RESERVED = 'did:web:nerv.tokyo.jp/general'
const ENGINEERING = 'did:web:nerv.tokyo.jp/engineering'

// A real OAuth AS handshake cannot be stubbed by a plain express server, so
// the PDS boundary is mocked at the module seam: the Agent's putRecord records
// every write and the oauthClient.restore stub injects failures.
const pds = vi.hoisted(() => ({
  putRecords: [] as Array<Record<string, unknown>>,
}))

vi.mock('@atproto/api', () => ({
  Agent: class {
    com = {
      atproto: {
        repo: {
          putRecord: async (args: Record<string, unknown>) => {
            pds.putRecords.push(args)
            return {}
          },
        },
      },
    }
    constructor(_session: unknown) {}
  },
}))

describe('PDS enrollment sync (sqlite integration)', () => {
  let testDir: string
  let db: ServiceDb
  let enrollmentStore: ReservedDomainEnrollmentStore
  let queue: SqlitePdsSyncQueueStore
  let restore: ReturnType<typeof vi.fn>

  const createAttestation = async () => ({
    sig: new Uint8Array([1, 2, 3]),
    signingKey: 'did:key:zServiceKey',
  })

  function createWorker(
    overrides: Partial<{
      tickMs: number
      backoffBaseMs: number
      backoffCapMs: number
      maxAttempts: number
    }> = {},
  ): PdsEnrollmentSyncWorker {
    return new PdsEnrollmentSyncWorker(
      {
        queue,
        sync: (did) =>
          syncEnrollmentRecordToPds(
            {
              enrollmentStore,
              createAttestation,
              oauthClient: { restore } as never,
              serviceDid: 'did:web:stratos.example.com',
              publicUrl: 'https://stratos.example.com',
            },
            did,
          ),
      },
      {
        tickMs: 25,
        backoffBaseMs: 5,
        backoffCapMs: 50,
        maxAttempts: 12,
        ...overrides,
      },
    )
  }

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-pds-sync-int-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })
    db = createServiceDb(join(testDir, 'service.sqlite'))
    await migrateServiceDb(db)
    enrollmentStore = new ReservedDomainEnrollmentStore(
      new SqliteEnrollmentStore(db),
      RESERVED,
    )
    queue = new SqlitePdsSyncQueueStore(db)
    restore = vi.fn(async () => ({}))
    pds.putRecords.length = 0

    await enrollmentStore.enroll({
      did: USAGI,
      enrolledAt: '2026-01-01T00:00:00.000Z',
      pdsEndpoint: 'https://pds.juban.tokyo.jp',
      signingKeyDid: 'did:key:zSailorMoon',
      active: true,
      boundaries: [ENGINEERING],
    })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('converges after a transient failure and writes the reserved domain', async () => {
    restore
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue({})
    const worker = createWorker()

    await worker.enqueue(USAGI)
    await expect(worker.kick(USAGI)).resolves.toBe('deferred')
    expect(pds.putRecords).toHaveLength(0)

    worker.start()
    try {
      await vi.waitFor(async () => {
        expect(await queue.list()).toHaveLength(0)
      })
    } finally {
      worker.stop()
    }

    expect(pds.putRecords).toHaveLength(1)
    const written = pds.putRecords[0]
    expect(written.repo).toBe(USAGI)
    expect(written.collection).toBe('zone.stratos.actor.enrollment')
    const record = written.record as {
      boundaries: Array<{ value: string }>
      signingKey: string
      service: string
    }
    const values = record.boundaries.map((b) => b.value)
    expect(values).toContain(ENGINEERING)
    // The reserved all-members domain is force-included by the store
    // decorator; a deferred write must re-derive it too.
    expect(values).toContain(RESERVED)
    expect(record.signingKey).toBe('did:key:zSailorMoon')
    expect(record.service).toBe('https://stratos.example.com')
  })

  it('recovers a pending job left behind by a crash on restart', async () => {
    // Durable intent exists but the inline attempt never ran (crash).
    await queue.upsertPending(USAGI)

    const worker = createWorker()
    worker.start()
    try {
      await vi.waitFor(async () => {
        expect(await queue.list()).toHaveLength(0)
      })
    } finally {
      worker.stop()
    }

    expect(pds.putRecords).toHaveLength(1)
  })

  it('surfaces a terminal failure and revives on the next admin mutation', async () => {
    const sessionGone = new Error('The session was deleted by another process')
    sessionGone.name = 'TokenRefreshError'
    restore.mockRejectedValueOnce(sessionGone).mockResolvedValue({})
    const worker = createWorker()

    await worker.enqueue(USAGI)
    await expect(worker.kick(USAGI)).resolves.toBe('deferred')

    const jobs = await queue.list()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].status).toBe('failed')
    expect(jobs[0].lastError).toContain('deleted by another process')

    // A fresh admin mutation re-enqueues and succeeds inline.
    await worker.enqueue(USAGI)
    await expect(worker.kick(USAGI)).resolves.toBe('ok')
    expect(await queue.list()).toHaveLength(0)
    expect(pds.putRecords).toHaveLength(1)
  })

  it('drops the job as obsolete when the actor unenrolled before the retry', async () => {
    await queue.upsertPending(USAGI)
    await enrollmentStore.unenroll(USAGI)

    const worker = createWorker()
    await expect(worker.kick(USAGI)).resolves.toBe('ok')
    expect(await queue.list()).toHaveLength(0)
    expect(pds.putRecords).toHaveLength(0)
  })
})
