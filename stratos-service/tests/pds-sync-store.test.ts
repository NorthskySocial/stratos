import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createServiceDb, migrateServiceDb, type ServiceDb } from '../src/db'
import { SqlitePdsSyncQueueStore } from '../src/features/enrollment/internal/pds-sync-store.js'

const USAGI = 'did:plc:usagitsukino'
const REI = 'did:plc:reihino'
const AMI = 'did:plc:amimizuno'

describe('SqlitePdsSyncQueueStore', () => {
  let testDir: string
  let db: ServiceDb
  let store: SqlitePdsSyncQueueStore

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-pds-sync-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })
    db = createServiceDb(join(testDir, 'service.sqlite'))
    await migrateServiceDb(db)
    store = new SqlitePdsSyncQueueStore(db)
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('upsertPending creates a due pending job', async () => {
    await store.upsertPending(USAGI)

    const jobs = await store.list()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].did).toBe(USAGI)
    expect(jobs[0].status).toBe('pending')
    expect(jobs[0].attemptCount).toBe(0)
    expect(jobs[0].lastError).toBeNull()

    const due = await store.listDue(new Date().toISOString(), 10)
    expect(due.map((j) => j.did)).toEqual([USAGI])
  })

  it('upsertPending revives a failed job and preserves firstQueuedAt', async () => {
    await store.upsertPending(USAGI)
    const [before] = await store.list()

    await store.markFailed(USAGI, 1, 'invalid_grant')
    const [failed] = await store.list()
    expect(failed.status).toBe('failed')

    await store.upsertPending(USAGI)
    const [revived] = await store.list()
    expect(revived.status).toBe('pending')
    expect(revived.attemptCount).toBe(0)
    expect(revived.lastError).toBeNull()
    expect(revived.firstQueuedAt).toBe(before.firstQueuedAt)
  })

  it('markRetry pushes nextAttemptAt into the future and hides the job from listDue', async () => {
    await store.upsertPending(USAGI)
    const future = new Date(Date.now() + 60_000).toISOString()

    await store.markRetry(USAGI, 1, 1, future, 'ECONNREFUSED')

    const dueNow = await store.listDue(new Date().toISOString(), 10)
    expect(dueNow).toHaveLength(0)

    const dueLater = await store.listDue(
      new Date(Date.now() + 120_000).toISOString(),
      10,
    )
    expect(dueLater).toHaveLength(1)
    expect(dueLater[0].attemptCount).toBe(1)
    expect(dueLater[0].lastError).toBe('ECONNREFUSED')
  })

  it('listDue excludes failed jobs and honors the limit in nextAttemptAt order', async () => {
    await store.upsertPending(USAGI)
    await store.markRetry(USAGI, 1, 1, '2020-01-01T00:00:02Z', 'later')
    await store.upsertPending(REI)
    await store.markRetry(REI, 1, 1, '2020-01-01T00:00:01Z', 'sooner')
    await store.upsertPending(AMI)
    await store.markFailed(AMI, 1, 'invalid_grant')

    const due = await store.listDue('2020-01-01T00:00:02Z', 1)
    expect(due.map((j) => j.did)).toEqual([REI])

    const dueAll = await store.listDue('2020-01-01T00:00:02Z', 10)
    expect(dueAll.map((j) => j.did)).toEqual([REI, USAGI])
  })

  it('remove deletes the job', async () => {
    await store.upsertPending(USAGI)
    await store.remove(USAGI)
    expect(await store.list()).toHaveLength(0)
  })

  it('remove is a no-op for an unknown did', async () => {
    await expect(store.remove('did:plc:unknown')).resolves.toBeUndefined()
  })

  it('list orders jobs by firstQueuedAt', async () => {
    await store.upsertPending(USAGI)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.upsertPending(REI)

    const jobs = await store.list()
    expect(jobs.map((j) => j.did)).toEqual([USAGI, REI])
  })
})
