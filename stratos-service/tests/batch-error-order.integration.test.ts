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
import { parentBoundaryCache } from '../src/api/records/validation.js'
import {
  asMember,
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  startPostgresWriteHarness,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'
import { startLabelRoute, type LabelRoute } from './helpers/label-route.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const LIKE = 'app.bsky.feed.like'
const POST = 'zone.stratos.feed.post'
const APPLY_WRITES = 'zone.stratos.repo.applyWrites'
const WRITE_TYPE = `${APPLY_WRITES}#`
const SHINJI = 'did:plc:shinji-ikari'
const MISATO = 'did:plc:misato-katsuragi'
const GENDO = 'did:plc:gendo-ikari'
const SUBJECT_BODY = {
  error: 'InvalidRecord',
  message: 'The subject must be a post in this boundary',
}
const SLOW_READ_MS = 80
const CREATED_AT = '1996-10-04T00:00:00.000Z'

const postUri = (author: string, rkey: string) =>
  `at://${author}/${POST}/${rkey}`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function defineBatchErrorOrder(getHarness: () => WriteHarness) {
  let harness: WriteHarness
  let labels: LabelRoute
  let subjects: Array<{ name: string; subject: { uri: string; cid: string } }>

  const likeWrite = (subject: { uri: string; cid: string }) => ({
    $type: `${WRITE_TYPE}create`,
    collection: LIKE,
    rkey: 'eva-like',
    value: { $type: LIKE, subject, createdAt: CREATED_AT },
  })

  // A reply into a boundary its parent is not in fails a post rule, and only
  // after the parent's boundaries have been read.
  const refusedPostWrite = () => {
    const parent = {
      uri: postUri(SHINJI, 'eva04'),
      cid: subjects[0].subject.cid,
    }
    return {
      $type: `${WRITE_TYPE}create`,
      collection: POST,
      rkey: 'eva-reply',
      value: {
        $type: POST,
        text: 'sortie',
        createdAt: CREATED_AT,
        reply: { root: parent, parent },
      },
    }
  }

  const batch = (writes: unknown[]) => {
    parentBoundaryCache.clear()
    return harness.call(APPLY_WRITES, asMember(MISATO), {
      boundary: HARNESS_ENGINEERING,
      repo: MISATO,
      writes,
    })
  }

  /** Delays one real store method, forwarding to it, for the next batch. */
  function delayStoreMethod(method: 'exists' | 'read') {
    const store = harness.ctx.actorStore
    const original = store[method].bind(store) as (
      ...args: unknown[]
    ) => Promise<unknown>
    vi.spyOn(store, method).mockImplementation((async (...args: unknown[]) => {
      await sleep(SLOW_READ_MS)
      return original(...args)
    }) as never)
  }

  beforeEach(async () => {
    harness = getHarness()
    await harness.enrollMember(SHINJI, [HARNESS_ENGINEERING, HARNESS_DESIGN])
    await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
    labels = await startLabelRoute(harness)

    const seed = async (rkey: string, boundary: string) => {
      const created = await harness.call(
        'zone.stratos.repo.createRecord',
        asMember(SHINJI),
        {
          boundary,
          repo: SHINJI,
          collection: POST,
          rkey,
          record: {
            $type: POST,
            text: `sortie ${rkey}`,
            createdAt: CREATED_AT,
          },
        },
      )
      expect(created.status).toBe(200)
      return {
        uri: postUri(SHINJI, rkey),
        cid: (created.body as { cid: string }).cid,
      }
    }
    const otherBoundary = await seed('eva04', HARNESS_DESIGN)
    const takenDown = await seed('eva03', HARNESS_ENGINEERING)
    expect(await labels.takeDownRecord(takenDown.uri)).toBe(200)
    subjects = [
      { name: 'in another boundary', subject: otherBoundary },
      { name: 'taken down', subject: takenDown },
      {
        name: 'by an author with no actor store',
        subject: { uri: postUri(GENDO, 'eva00'), cid: otherBoundary.cid },
      },
    ]
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await labels.close()
  })

  it('reports the like when it comes first, whatever the subject lacks and however slowly it is looked up', async () => {
    const refusedAlone = await batch([refusedPostWrite()])
    expect(refusedAlone.status).toBe(400)
    delayStoreMethod('exists')

    const answers = []
    for (const { subject } of subjects) {
      answers.push(await batch([likeWrite(subject), refusedPostWrite()]))
    }

    expect(answers.map((answer) => answer.status)).toEqual([400, 400, 400])
    expect(answers.map((answer) => answer.body)).toEqual([
      SUBJECT_BODY,
      SUBJECT_BODY,
      SUBJECT_BODY,
    ])
  })

  it('reports the post when it comes first, whatever the like lacks and however slowly the post is looked up', async () => {
    const refusedAlone = await batch([refusedPostWrite()])
    expect(refusedAlone.status).toBe(400)
    delayStoreMethod('read')

    const answers = []
    for (const { subject } of subjects) {
      answers.push(await batch([refusedPostWrite(), likeWrite(subject)]))
    }

    expect(answers.map((answer) => answer.status)).toEqual([400, 400, 400])
    expect(answers.map((answer) => answer.body)).toEqual([
      refusedAlone.body,
      refusedAlone.body,
      refusedAlone.body,
    ])
  })
}

describe('which write a refused batch names on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  defineBatchErrorOrder(() => harness)
})

describe('which write a refused batch names on postgres', () => {
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

  defineBatchErrorOrder(() => harness)
})
