import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

import { createAppContext, type AppContext } from '../src/context.js'
import { createRecord } from '../src/api/records/index.js'
import { cborToRecord, createMockBlobStore, createTestConfig } from './utils'

const SERVICE_DID = 'did:web:stratos.test'
const ENGINEERING = `${SERVICE_DID}/engineering`
const DESIGN = `${SERVICE_DID}/design`
const GENERAL = `${SERVICE_DID}/general`
const COLLECTION = 'zone.stratos.feed.post'
const PILOT = 'did:plc:shinji-ikari'
const FIRST_REVISION = 1

function post(text: string, boundary: string) {
  return {
    $type: COLLECTION,
    text,
    createdAt: '2026-01-01T00:00:00.000Z',
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: [{ value: boundary }],
    },
  }
}

describe('Write authorization while a catalog boundary is being deactivated', () => {
  let dataDir: string
  let ctx: AppContext

  function writePost(rkey: string, boundary: string) {
    return createRecord(
      ctx,
      {
        repo: PILOT,
        collection: COLLECTION,
        rkey,
        record: post('Unit-01 sortie', boundary),
      },
      PILOT,
    )
  }

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-write-deactivation-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })
    const base = createTestConfig(dataDir)
    ctx = await createAppContext({
      cfg: {
        ...base,
        stratos: {
          ...base.stratos,
          serviceDid: SERVICE_DID,
          allowedDomains: [ENGINEERING, DESIGN, GENERAL],
          reservedDomain: GENERAL,
        },
      },
      blobstore: () => createMockBlobStore(),
      cborToRecord,
    })
    await ctx.enrollmentStore.enroll({
      did: PILOT,
      enrolledAt: '2026-01-01T00:00:00.000Z',
      boundaries: [ENGINEERING, DESIGN],
      signingKeyDid: 'did:key:zEvaTestKey',
      active: true,
      isService: false,
      custody: 'stratos',
    })
    await ctx.actorStore.create(PILOT)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await ctx.destroy()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('rejects a write to the boundary before the member is drained, then reads the store after the drain event', async () => {
    await writePost('sortie-one', DESIGN)

    // Hold the per-member drain so the member still has the boundary cached.
    let releaseDrain: () => void = () => undefined
    const drainHeld = new Promise<void>((resolve) => {
      releaseDrain = resolve
    })
    const removeBoundary = ctx.enrollmentStore.removeBoundary.bind(
      ctx.enrollmentStore,
    )
    const removeBoundarySpy = vi
      .spyOn(ctx.enrollmentStore, 'removeBoundary')
      .mockImplementationOnce(async (did, boundary) => {
        await drainHeld
        await removeBoundary(did, boundary)
      })

    const deactivation = ctx.boundaryManager!.deactivate(DESIGN, FIRST_REVISION)
    await vi.waitFor(() => {
      expect(removeBoundarySpy).toHaveBeenCalledTimes(1)
    })
    expect(await ctx.boundaryStore!.get(DESIGN)).toMatchObject({
      status: 'deactivating',
    })

    await expect(writePost('sortie-two', DESIGN)).rejects.toMatchObject({
      error: 'InvalidRecord',
      message: expect.stringContaining('is not allowed'),
    })
    await expect(writePost('sortie-three', ENGINEERING)).resolves.toBeDefined()

    const getBoundariesFromStore = vi.spyOn(
      ctx.enrollmentStore,
      'getBoundaries',
    )
    releaseDrain()
    await deactivation

    getBoundariesFromStore.mockClear()
    await expect(writePost('sortie-four', ENGINEERING)).resolves.toBeDefined()
    // Once to refill the cleared cache, once under the repo lock.
    expect(getBoundariesFromStore).toHaveBeenCalledTimes(2)
    await expect(writePost('sortie-five', DESIGN)).rejects.toMatchObject({
      error: 'InvalidRecord',
    })
  })
})
