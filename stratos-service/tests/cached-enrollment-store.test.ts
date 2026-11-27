import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

import { createAppContext, type AppContext } from '../src/context.js'
import { cborToRecord, createMockBlobStore, createTestConfig } from './utils'

vi.mock('ioredis', () => ({
  Redis: class {
    on = vi.fn()
    get = vi.fn().mockResolvedValue(null)
    set = vi.fn().mockResolvedValue('OK')
    del = vi.fn().mockResolvedValue(0)
    quit = vi.fn().mockResolvedValue('OK')
    disconnect = vi.fn()
  },
}))

const SERVICE_DID = 'did:web:stratos.test'
const LEGACY_NAME = 'engineering'
const SERVICE_REF = `${SERVICE_DID}#atproto_pns`
const QUALIFIED_NAME = `${SERVICE_REF}/${LEGACY_NAME}`
const GENERAL = `${SERVICE_REF}/general`
const PILOT = 'did:plc:rei-ayanami'

describe('Write boundary cache with the migrating resolver', () => {
  let dataDir: string
  let ctx: AppContext

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-write-cache-migrating-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })
    const base = createTestConfig(dataDir)
    ctx = await createAppContext({
      cfg: {
        ...base,
        enrollment: { ...base.enrollment, valkeyUrl: 'redis://valkey.test' },
        stratos: {
          ...base.stratos,
          serviceDid: SERVICE_DID,
          allowedDomains: [LEGACY_NAME, QUALIFIED_NAME, GENERAL],
          reservedDomain: GENERAL,
        },
      },
      blobstore: () => createMockBlobStore(),
      cborToRecord,
    })
    vi.spyOn(ctx.profileRecordWriter, 'putEnrollmentRecord').mockResolvedValue(
      undefined as never,
    )
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await ctx.destroy()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('resolves a legacy name as qualified, then repairs it with one event and a cleared entry', async () => {
    await ctx.enrollmentStore.enroll({
      did: PILOT,
      enrolledAt: '2026-01-01T00:00:00.000Z',
      boundaries: [LEGACY_NAME],
      signingKeyDid: 'did:key:zReiTestKey',
      active: true,
      isService: false,
      custody: 'stratos',
    })
    await ctx.actorStore.create(PILOT)
    const events: unknown[] = []
    ctx.enrollmentEvents.on('enrollment', (event) => events.push(event))
    const readStore = vi.spyOn(ctx.enrollmentStore, 'getBoundaries')

    const resolved = await ctx.writeBoundaryResolver!.getBoundaries(PILOT)
    expect(resolved).toContain(QUALIFIED_NAME)
    expect(resolved).not.toContain(LEGACY_NAME)

    await vi.waitFor(() => {
      expect(events).toHaveLength(1)
    })
    const stored = await ctx.enrollmentStore.getBoundaries(PILOT)
    expect(stored).toContain(QUALIFIED_NAME)
    expect(stored).not.toContain(LEGACY_NAME)

    readStore.mockClear()
    await ctx.writeBoundaryResolver!.getBoundaries(PILOT)
    expect(readStore).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(1)
  })
})
