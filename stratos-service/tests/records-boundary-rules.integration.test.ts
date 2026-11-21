import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  asMember,
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  startPostgresWriteHarness,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'
import { assertBoundaryInCatalog } from '../src/api/records/validation.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const PILOT = 'did:plc:shinji-ikari'
const COLLECTION = 'zone.stratos.feed.post'
const PARENT_CID = 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const CREATE = 'zone.stratos.repo.createRecord'
const LEGACY_CREATE = 'com.atproto.repo.createRecord'

const uriOf = (rkey: string) => `at://${PILOT}/${COLLECTION}/${rkey}`

function claim(boundary: string) {
  return {
    $type: 'zone.stratos.boundary.defs#Domains',
    values: [{ value: boundary }],
  }
}

function post(text: string, extra: Record<string, unknown> = {}) {
  return {
    $type: COLLECTION,
    text,
    createdAt: '1996-10-04T00:00:00.000Z',
    ...extra,
  }
}

function writeIn(
  harness: WriteHarness,
  boundary: string,
  rkey: string,
  record: unknown = post('Sortie'),
) {
  return harness.call(CREATE, asMember(PILOT), {
    boundary,
    repo: PILOT,
    collection: COLLECTION,
    rkey,
    record,
  })
}

function legacyWriteIn(harness: WriteHarness, boundary: string, rkey: string) {
  return harness.call(LEGACY_CREATE, asMember(PILOT), {
    repo: PILOT,
    collection: COLLECTION,
    rkey,
    record: post('Sortie', { boundary: claim(boundary) }),
  })
}

async function snapshot(harness: WriteHarness, rkey: string) {
  return {
    rows: await harness.recordRows(uriOf(rkey)),
    root: await harness.repoRoot(PILOT),
    ops: await harness.sequencedOps(PILOT),
  }
}

/**
 * Holds the member drain of the next deactivation open, so the boundary is
 * `deactivating` in the catalog while the write cache still lists it.
 */
function holdNextDrain(harness: WriteHarness) {
  const { ctx } = harness
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const removeBoundary = ctx.enrollmentStore.removeBoundary.bind(
    ctx.enrollmentStore,
  )
  const spy = vi
    .spyOn(ctx.enrollmentStore, 'removeBoundary')
    .mockImplementationOnce(async (did, boundary) => {
      await held
      await removeBoundary(did, boundary)
    })
  const started: Promise<unknown>[] = []
  return {
    release,
    /** Starts the deactivation and returns once the drain is held open. */
    async deactivate(boundary: string) {
      const finished = ctx.boundaryManager!.deactivate(
        boundary,
        await currentRevision(harness, boundary),
      )
      started.push(finished)
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
      return { finished }
    },
    async settle() {
      release()
      await Promise.all(started)
    },
  }
}

async function currentRevision(harness: WriteHarness, boundary: string) {
  const definition = await harness.ctx.boundaryStore!.get(boundary)
  return definition!.revision
}

/** A Postgres container keeps its catalog from one harness to the next. */
async function reactivateDesign(harness: WriteHarness) {
  const definition = await harness.ctx.boundaryStore!.get(HARNESS_DESIGN)
  if (definition && definition.status !== 'active') {
    await harness.ctx.boundaryManager!.reactivate(
      HARNESS_DESIGN,
      definition.revision,
    )
  }
}

function defineBodylessScenarios(getHarness: () => WriteHarness) {
  describe('a body without a boundary', () => {
    let harness: WriteHarness

    beforeEach(async () => {
      harness = getHarness()
      await harness.enrollMember(PILOT, [HARNESS_ENGINEERING, HARNESS_DESIGN])
    })

    it('accepts a post whose body carries no boundary', async () => {
      const response = await writeIn(harness, HARNESS_ENGINEERING, 'eva00')

      expect(response.status).toBe(200)
      expect((await harness.recordRows(uriOf('eva00'))).boundaries).toEqual([
        HARNESS_ENGINEERING,
      ])
    })
  })
}

function defineCatalogWindowScenarios(getHarness: () => WriteHarness) {
  describe('a boundary the catalog has deactivated', () => {
    let harness: WriteHarness
    let drain: ReturnType<typeof holdNextDrain> | undefined

    beforeEach(async () => {
      harness = getHarness()
      await harness.enrollMember(PILOT, [HARNESS_ENGINEERING, HARNESS_DESIGN])
      expect((await writeIn(harness, HARNESS_DESIGN, 'eva-warm')).status).toBe(
        200,
      )
      drain = holdNextDrain(harness)
    })

    afterEach(async () => {
      await drain?.settle()
      vi.restoreAllMocks()
      await reactivateDesign(harness)
    })

    it('refuses a boundary the cache lists but the catalog has deactivated, until the drain lands', async () => {
      const { finished } = await drain!.deactivate(HARNESS_DESIGN)
      const before = await snapshot(harness, 'eva00')

      const inWindow = await writeIn(harness, HARNESS_DESIGN, 'eva00')

      expect(inWindow.status).toBe(400)
      expect(inWindow.body).toMatchObject({ error: 'BoundaryNotFound' })
      expect(await snapshot(harness, 'eva00')).toEqual(before)

      drain!.release()
      await finished
      const afterDrain = await writeIn(harness, HARNESS_DESIGN, 'eva01')

      expect(afterDrain.status).toBe(400)
      expect(afterDrain.body).toMatchObject({ error: 'ForbiddenBoundary' })
    })

    it('refuses a deactivation that lands after the up-front checks and stores nothing', async () => {
      const before = await snapshot(harness, 'eva00')
      const locks = harness.ctx.repoWriteLocks
      const realAcquire = locks.acquire.bind(locks)
      let armed = true
      vi.spyOn(locks, 'acquire').mockImplementation(async (did: string) => {
        if (armed) {
          armed = false
          await drain!.deactivate(HARNESS_DESIGN)
        }
        return realAcquire(did)
      })

      const response = await writeIn(harness, HARNESS_DESIGN, 'eva00')

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'BoundaryNotFound' })
      expect(await snapshot(harness, 'eva00')).toEqual(before)
    })

    it('still answers a legacy write in the window with the post rule', async () => {
      await drain!.deactivate(HARNESS_DESIGN)

      const response = await legacyWriteIn(harness, HARNESS_DESIGN, 'eva00')

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({
        error: 'InvalidRecord',
        message: expect.stringContaining('is not allowed'),
      })
    })
  })
}

function defineRuleScenarios(getHarness: () => WriteHarness) {
  describe('reply and catalog rules', () => {
    let harness: WriteHarness

    beforeEach(async () => {
      harness = getHarness()
      await harness.enrollMember(PILOT, [HARNESS_ENGINEERING, HARNESS_DESIGN])
    })

    afterEach(async () => {
      vi.restoreAllMocks()
      await reactivateDesign(harness)
    })

    async function seedParent() {
      const seeded = await legacyWriteIn(harness, HARNESS_ENGINEERING, 'eva-op')
      expect(seeded.status).toBe(200)
    }

    const replyTo = (text: string) =>
      post(text, {
        reply: {
          root: { uri: uriOf('eva-op'), cid: PARENT_CID },
          parent: { uri: uriOf('eva-op'), cid: PARENT_CID },
        },
      })

    it('accepts a reply in the boundary of its parent', async () => {
      await seedParent()

      const response = await writeIn(
        harness,
        HARNESS_ENGINEERING,
        'eva-reply',
        replyTo('Roger'),
      )

      expect(response.status).toBe(200)
    })

    it('refuses a reply that escalates beyond its parent with the legacy message', async () => {
      await seedParent()
      const before = await snapshot(harness, 'eva-reply')

      const response = await writeIn(
        harness,
        HARNESS_DESIGN,
        'eva-reply',
        replyTo('Roger'),
      )

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'InvalidRecord',
        message: `Reply boundaries must be a subset of the parent's boundaries. Domains not in parent: ${HARNESS_DESIGN}`,
      })
      expect(await snapshot(harness, 'eva-reply')).toEqual(before)
    })

    it('gives an unheld boundary that is also deactivated ForbiddenBoundary', async () => {
      await harness.ctx.boundaryManager!.deactivate(
        HARNESS_DESIGN,
        await currentRevision(harness, HARNESS_DESIGN),
      )

      const response = await writeIn(harness, HARNESS_DESIGN, 'eva00')

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'ForbiddenBoundary' })
    })

    it('refuses a boundary when the context has no catalog store to read', async () => {
      const withoutCatalog = { ...harness.ctx, boundaryStore: undefined }

      await expect(
        assertBoundaryInCatalog(withoutCatalog, HARNESS_ENGINEERING),
      ).rejects.toMatchObject({
        customErrorName: 'BoundaryNotFound',
        message: `Boundary ${HARNESS_ENGINEERING} is not in the active catalog`,
      })
    })
  })
}

describe('boundary write rules on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  defineBodylessScenarios(() => harness)
  defineRuleScenarios(() => harness)
  defineCatalogWindowScenarios(() => harness)
})

describe('boundary write rules on postgres', () => {
  let connectionString: string
  let harness: WriteHarness

  beforeAll(async () => {
    connectionString = await startPostgresContainer()
  }, 120_000)

  afterAll(async () => {
    await stopPostgresContainer()
  }, 60_000)

  beforeEach(async () => {
    harness = await startPostgresWriteHarness(connectionString)
  }, 60_000)

  afterEach(async () => {
    await harness.close()
  })

  defineBodylessScenarios(() => harness)
  defineCatalogWindowScenarios(() => harness)
})
