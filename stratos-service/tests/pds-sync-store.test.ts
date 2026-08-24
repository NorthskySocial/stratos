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

  it('removeIfCurrent deletes the job when the generation is still current', async () => {
    const generation = await store.upsertPending(USAGI)

    await expect(store.removeIfCurrent(USAGI, generation)).resolves.toBe(true)
    expect(await store.list()).toHaveLength(0)
  })

  it('removeIfCurrent keeps the job when a newer intent superseded it', async () => {
    const stale = await store.upsertPending(USAGI)
    const current = await store.upsertPending(USAGI)
    expect(current).toBeGreaterThan(stale)

    await expect(store.removeIfCurrent(USAGI, stale)).resolves.toBe(false)

    const [survivor] = await store.list()
    expect(survivor.did).toBe(USAGI)
    expect(survivor.generation).toBe(current)
  })

  it('removeIfCurrent reports false for an unknown did', async () => {
    await expect(store.removeIfCurrent('did:plc:unknown', 1)).resolves.toBe(
      false,
    )
  })

  it('markRetry and markFailed ignore a superseded generation', async () => {
    const stale = await store.upsertPending(USAGI)
    const current = await store.upsertPending(USAGI)

    await store.markFailed(USAGI, stale, 'invalid_grant')
    await store.markRetry(
      USAGI,
      stale,
      5,
      new Date(Date.now() + 60_000).toISOString(),
      'stale write',
    )

    const [job] = await store.list()
    expect(job.status).toBe('pending')
    expect(job.attemptCount).toBe(0)
    expect(job.lastError).toBeNull()
    expect(job.generation).toBe(current)
  })

  it('requeueFailed revives every failed job and bumps its generation', async () => {
    const usagiGeneration = await store.upsertPending(USAGI)
    await store.markFailed(USAGI, usagiGeneration, 'invalid_grant')
    const reiGeneration = await store.upsertPending(REI)
    await store.markFailed(REI, reiGeneration, 'invalid_grant')
    await store.upsertPending(AMI)

    await expect(store.requeueFailed()).resolves.toBe(2)

    const jobs = await store.list()
    expect(jobs.map((j) => j.status)).toEqual(['pending', 'pending', 'pending'])

    const usagi = jobs.find((j) => j.did === USAGI)
    expect(usagi?.attemptCount).toBe(0)
    expect(usagi?.lastError).toBeNull()
    expect(usagi?.generation).toBeGreaterThan(usagiGeneration)

    const due = await store.listDue(new Date().toISOString(), 10)
    expect(due.map((j) => j.did).sort()).toEqual([AMI, REI, USAGI].sort())
  })

  it('requeueFailed reports zero when no job has failed', async () => {
    await store.upsertPending(USAGI)

    await expect(store.requeueFailed()).resolves.toBe(0)
    expect((await store.list())[0].status).toBe('pending')
  })

  it('list orders jobs by firstQueuedAt', async () => {
    await store.upsertPending(USAGI)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.upsertPending(REI)

    const jobs = await store.list()
    expect(jobs.map((j) => j.did)).toEqual([USAGI, REI])
  })
})
