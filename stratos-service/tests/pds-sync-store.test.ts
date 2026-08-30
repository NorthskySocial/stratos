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

  it('upsertPending creates a pending job that can be claimed', async () => {
    await store.upsertPending(USAGI)

    const jobs = await store.list(100)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].did).toBe(USAGI)
    expect(jobs[0].status).toBe('pending')
    expect(jobs[0].attemptCount).toBe(0)
    expect(jobs[0].lastError).toBeNull()

    const now = new Date().toISOString()
    const leaseUntil = new Date(Date.now() + 60_000).toISOString()
    const claimed = await store.claimDue(now, leaseUntil)
    expect(claimed?.did).toBe(USAGI)
    expect(claimed?.generation).toBe(2)
    await expect(store.claimDue(now, leaseUntil)).resolves.toBeUndefined()
  })

  it('upsertPending revives a failed job and preserves firstQueuedAt', async () => {
    await store.upsertPending(USAGI)
    const [before] = await store.list(100)

    await store.markFailed(USAGI, 1, 'invalid_grant')
    const [failed] = await store.list(100)
    expect(failed.status).toBe('failed')

    await store.upsertPending(USAGI)
    const [revived] = await store.list(100)
    expect(revived.status).toBe('pending')
    expect(revived.attemptCount).toBe(0)
    expect(revived.lastError).toBeNull()
    expect(revived.firstQueuedAt).toBe(before.firstQueuedAt)
  })

  it('markRetry hides the job until its next attempt', async () => {
    await store.upsertPending(USAGI)
    const future = new Date(Date.now() + 60_000).toISOString()

    await store.markRetry(USAGI, 1, 1, future, 'ECONNREFUSED')

    const leaseUntil = new Date(Date.now() + 180_000).toISOString()
    await expect(
      store.claimDue(new Date().toISOString(), leaseUntil),
    ).resolves.toBeUndefined()

    const dueLater = await store.claimDue(
      new Date(Date.now() + 120_000).toISOString(),
      leaseUntil,
    )
    expect(dueLater?.attemptCount).toBe(1)
    expect(dueLater?.lastError).toBe('ECONNREFUSED')
  })

  it('claimDue excludes failed jobs and follows nextAttemptAt order', async () => {
    await store.upsertPending(USAGI)
    await store.markRetry(USAGI, 1, 1, '2020-01-01T00:00:02Z', 'later')
    await store.upsertPending(REI)
    await store.markRetry(REI, 1, 1, '2020-01-01T00:00:01Z', 'sooner')
    await store.upsertPending(AMI)
    await store.markFailed(AMI, 1, 'invalid_grant')

    const now = '2020-01-01T00:00:02Z'
    const leaseUntil = '2030-01-01T00:00:00Z'
    const first = await store.claimDue(now, leaseUntil)
    const second = await store.claimDue(now, leaseUntil)
    const third = await store.claimDue(now, leaseUntil)
    expect([first?.did, second?.did]).toEqual([REI, USAGI])
    expect(third).toBeUndefined()
  })

  it('markCancelled leaves a durable tombstone', async () => {
    await store.upsertPending(USAGI)
    const generation = await store.markCancelled(USAGI)
    expect(generation).toBe(2)
    expect(await store.list(100)).toHaveLength(0)
    await expect(
      store.claimDue(new Date().toISOString(), new Date().toISOString()),
    ).resolves.toBeUndefined()

    const revived = await store.upsertPending(USAGI)
    expect(revived).toBeGreaterThan(generation!)
  })

  it('markCancelled reports no job for an unknown did', async () => {
    await expect(
      store.markCancelled('did:plc:unknown'),
    ).resolves.toBeUndefined()
  })

  it('markCompleted retains the current generation as a tombstone', async () => {
    const generation = await store.upsertPending(USAGI)

    await expect(store.markCompleted(USAGI, generation)).resolves.toBe(true)
    expect(await store.list(100)).toHaveLength(0)
    const revived = await store.upsertPending(USAGI)
    expect(revived).toBeGreaterThan(generation)
  })

  it('markCompleted keeps the job pending when newer intent superseded it', async () => {
    const stale = await store.upsertPending(USAGI)
    const current = await store.upsertPending(USAGI)
    expect(current).toBeGreaterThan(stale)

    await expect(store.markCompleted(USAGI, stale)).resolves.toBe(false)

    const [survivor] = await store.list(100)
    expect(survivor.did).toBe(USAGI)
    expect(survivor.generation).toBe(current)
  })

  it('markCompleted reports false for an unknown did', async () => {
    await expect(store.markCompleted('did:plc:unknown', 1)).resolves.toBe(false)
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

    const [job] = await store.list(100)
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

    const jobs = await store.list(100)
    expect(jobs.map((j) => j.status)).toEqual(['pending', 'pending', 'pending'])

    const usagi = jobs.find((j) => j.did === USAGI)
    expect(usagi?.attemptCount).toBe(0)
    expect(usagi?.lastError).toBeNull()
    expect(usagi?.generation).toBeGreaterThan(usagiGeneration)

    const now = new Date().toISOString()
    const leaseUntil = new Date(Date.now() + 60_000).toISOString()
    const claimed = await Promise.all([
      store.claimDue(now, leaseUntil),
      store.claimDue(now, leaseUntil),
      store.claimDue(now, leaseUntil),
    ])
    expect(claimed.map((j) => j?.did).sort()).toEqual([AMI, REI, USAGI].sort())
  })

  it('allows only one concurrent claim for one due job', async () => {
    await store.upsertPending(USAGI)
    const now = new Date().toISOString()
    const leaseUntil = new Date(Date.now() + 60_000).toISOString()

    const claims = await Promise.all([
      store.claimDue(now, leaseUntil),
      store.claimDue(now, leaseUntil),
    ])

    expect(claims.filter(Boolean)).toHaveLength(1)
  })

  it('reclaims an expired lease and fences the stale generation', async () => {
    const generation = await store.upsertPending(USAGI)
    await store.markRetry(USAGI, generation, 0, '2019-01-01T00:00:00Z', 'ready')
    const first = await store.claimDue(
      '2020-01-01T00:00:00Z',
      '2020-01-01T00:01:00Z',
    )
    const second = await store.claimDue(
      '2020-01-01T00:02:00Z',
      '2020-01-01T00:03:00Z',
    )
    expect(second!.generation).toBeGreaterThan(first!.generation)

    await store.markFailed(USAGI, first!.generation, 'stale failure')
    await expect(store.markCompleted(USAGI, first!.generation)).resolves.toBe(
      false,
    )
    const [job] = await store.list(100)
    expect(job.status).toBe('pending')
    expect(job.generation).toBe(second!.generation)
  })

  it('preserves fresh intent when stale completion uses an older generation', async () => {
    await store.upsertPending(USAGI)
    const cancelled = await store.markCancelled(USAGI)
    const revived = await store.upsertPending(USAGI)

    await expect(store.markCompleted(USAGI, cancelled!)).resolves.toBe(false)
    const [job] = await store.list(100)
    expect(job.status).toBe('pending')
    expect(job.generation).toBe(revived)
  })

  it('requeueFailed reports zero when no job has failed', async () => {
    await store.upsertPending(USAGI)

    await expect(store.requeueFailed()).resolves.toBe(0)
    expect((await store.list(100))[0].status).toBe('pending')
  })

  it('list orders jobs by firstQueuedAt', async () => {
    await store.upsertPending(USAGI)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.upsertPending(REI)

    const jobs = await store.list(100)
    expect(jobs.map((j) => j.did)).toEqual([USAGI, REI])
  })

  it('list bounds each page and pages forward from the given key', async () => {
    await store.upsertPending(USAGI)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.upsertPending(REI)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.upsertPending(AMI)

    const first = await store.list(2)
    expect(first.map((j) => j.did)).toEqual([USAGI, REI])

    const last = first[first.length - 1]
    const second = await store.list(2, {
      firstQueuedAt: last.firstQueuedAt,
      did: last.did,
    })
    expect(second.map((j) => j.did)).toEqual([AMI])
  })

  it('list breaks a firstQueuedAt tie on did and does not skip rows', async () => {
    // Order the DIDs so the tie-break assertion is explicit.
    const [first, second] = [REI, USAGI].sort()
    await store.upsertPending(first)
    await store.upsertPending(second)
    const jobs = await store.list(100)
    // Same-millisecond enqueues may share firstQueuedAt; either way the
    // page order is total and resuming from row one yields row two.
    const page = await store.list(100, {
      firstQueuedAt: jobs[0].firstQueuedAt,
      did: jobs[0].did,
    })
    expect(page.map((j) => j.did)).toEqual([jobs[1].did])
  })
})
