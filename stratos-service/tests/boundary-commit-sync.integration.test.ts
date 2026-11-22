import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import {
  applyBoundaryWrites,
  type BoundaryWrite,
  deleteRecordInBoundary,
} from '../src/api/records/boundary-writes.js'
import { listRepoOps } from '../src/features/pull-sync/index.js'
import {
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  type SequencedOp,
  startPostgresWriteHarness,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'
import {
  type CommitFrame,
  startSyncSubscriber,
  type SyncSubscriber,
} from './helpers/sync-subscriber.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const PILOT = 'did:plc:shinji-ikari'
const MAGI = 'did:web:magi.tokyo.jp'
const SEELE = 'did:web:seele.example'
const COLLECTION = 'zone.stratos.feed.post'

const pathOf = (rkey: string) => `${COLLECTION}/${rkey}`

function post(text: string) {
  return {
    $type: COLLECTION,
    text,
    createdAt: '1997-07-19T00:00:00.000Z',
  }
}

const create = (rkey: string): BoundaryWrite => ({
  kind: 'create',
  collection: COLLECTION,
  rkey,
  record: post(rkey),
})

const put = (rkey: string): BoundaryWrite => ({
  kind: 'put',
  collection: COLLECTION,
  rkey,
  record: post(`${rkey} again`),
})

const remove = (rkey: string): BoundaryWrite => ({
  kind: 'delete',
  collection: COLLECTION,
  rkey,
})

/** The sequenced ops grouped by the event that carries them, in log order. */
async function sequencedEvents(
  harness: WriteHarness,
): Promise<SequencedOp[][]> {
  const events = new Map<number, SequencedOp[]>()
  for (const op of await harness.sequencedOps(PILOT)) {
    events.set(op.seq, [...(events.get(op.seq) ?? []), op])
  }
  return [...events.values()]
}

const carries = (rkey: string) => (frame: CommitFrame) =>
  frame.ops.some((op) => op.path === pathOf(rkey))

const opsOf = (frames: CommitFrame[]) =>
  frames.map((frame) => frame.ops.map(({ action, path }) => ({ action, path })))

function defineBoundaryCommitSync(getHarness: () => WriteHarness) {
  let harness: WriteHarness
  let magi: SyncSubscriber

  const writeEngineering = (writes: BoundaryWrite[]) =>
    applyBoundaryWrites(harness.ctx, PILOT, HARNESS_ENGINEERING, writes)

  const pullEngineering = (limit: number) =>
    listRepoOps(
      harness.ctx,
      { did: PILOT, limit, excludeValues: false },
      new Set([HARNESS_ENGINEERING]),
    )

  async function takeDown(rkey: string) {
    await harness.ctx.actorStore.transact(PILOT, (store) =>
      store.record.updateRecordTakedown(`at://${PILOT}/${pathOf(rkey)}`, {
        applied: true,
        ref: 'takedown-nerv',
      }),
    )
  }

  beforeEach(async () => {
    harness = getHarness()
    await harness.enrollMember(PILOT, [HARNESS_ENGINEERING, HARNESS_DESIGN])
    magi = await startSyncSubscriber(harness, MAGI, [HARNESS_ENGINEERING])
  })

  afterEach(async () => {
    await magi.close()
  })

  it('pages a two-create batch whole even with a limit of one', async () => {
    await writeEngineering([create('eva00'), create('eva01')])

    const page = await pullEngineering(1)

    expect(page.ops.map((op) => op.rkey)).toEqual(['eva00', 'eva01'])
    expect(new Set(page.ops.map((op) => op.rev)).size).toBe(1)
  })

  it('delivers a two-create batch as one commit frame', async () => {
    await writeEngineering([create('eva00'), create('eva01')])

    const frames = await magi.readCommitFrames(PILOT, 0, carries('eva01'))

    expect(opsOf(frames)).toEqual([
      [
        { action: 'create', path: pathOf('eva00') },
        { action: 'create', path: pathOf('eva01') },
      ],
    ])
  })

  it('sequences a create, a put and a delete as one event in commit order with one delete op', async () => {
    await writeEngineering([create('eva02'), create('eva03')])

    await writeEngineering([create('eva04'), put('eva02'), remove('eva03')])

    const events = await sequencedEvents(harness)
    expect(events).toHaveLength(2)
    const batch = events[1].map(({ action, path, scope, exclude }) => ({
      action,
      path,
      scope,
      exclude,
    }))
    const scoped = { scope: [HARNESS_ENGINEERING], exclude: [] }
    expect(batch).toEqual([
      { action: 'create', path: pathOf('eva04'), ...scoped },
      { action: 'update', path: pathOf('eva02'), ...scoped },
      { action: 'delete', path: pathOf('eva03'), ...scoped },
    ])

    const frames = await magi.readCommitFrames(PILOT, 0, carries('eva04'))
    expect(opsOf(frames)[1]).toEqual([
      { action: 'create', path: pathOf('eva04') },
      { action: 'update', path: pathOf('eva02') },
      { action: 'delete', path: pathOf('eva03') },
    ])
    const pulled = await pullEngineering(100)
    expect(
      pulled.ops.map(({ rkey, cid }) => ({ rkey, deleted: !cid })),
    ).toEqual([
      { rkey: 'eva02', deleted: false },
      { rkey: 'eva03', deleted: true },
      { rkey: 'eva04', deleted: false },
    ])
  })

  it('sequences a single create as one event with one op', async () => {
    await writeEngineering([create('eva00')])

    const events = await sequencedEvents(harness)
    expect(events.map((ops) => ops.map((op) => op.path))).toEqual([
      [pathOf('eva00')],
    ])
    const frames = await magi.readCommitFrames(PILOT, 0, carries('eva00'))
    expect(opsOf(frames)).toEqual([
      [{ action: 'create', path: pathOf('eva00') }],
    ])
  })

  it('sequences a single boundary delete as one scoped delete op', async () => {
    await writeEngineering([create('eva00')])

    await deleteRecordInBoundary(
      harness.ctx,
      PILOT,
      HARNESS_ENGINEERING,
      COLLECTION,
      'eva00',
    )

    const events = await sequencedEvents(harness)
    expect(events[1].map(({ action, scope }) => ({ action, scope }))).toEqual([
      { action: 'delete', scope: [HARNESS_ENGINEERING] },
    ])
    const frames = await magi.readCommitFrames(
      PILOT,
      0,
      (frame) => frame.ops[0]?.action === 'delete',
    )
    expect(opsOf(frames)[1]).toEqual([
      { action: 'delete', path: pathOf('eva00') },
    ])
  })

  it('replays the whole commit from a cursor before it and nothing of it from its own sequence or later', async () => {
    await writeEngineering([create('eva00'), create('eva01')])
    await writeEngineering([create('sachiel')])
    await writeEngineering([create('shamshel')])
    const [commitSeq] = (await sequencedEvents(harness)).map(
      ([first]) => first.seq,
    )

    const fromCursor = async (cursor: number) =>
      opsOf(
        await magi.readCommitFrames(PILOT, cursor, carries('shamshel')),
      ).map((ops) => ops.map((op) => op.path))

    expect(await fromCursor(commitSeq - 1)).toEqual([
      [pathOf('eva00'), pathOf('eva01')],
      [pathOf('sachiel')],
      [pathOf('shamshel')],
    ])
    expect(await fromCursor(commitSeq)).toEqual([
      [pathOf('sachiel')],
      [pathOf('shamshel')],
    ])
    expect(await fromCursor(commitSeq + 1)).toEqual([[pathOf('shamshel')]])
  })

  it('sends a subscriber outside the boundary nothing of the commit', async () => {
    const seele = await startSyncSubscriber(harness, SEELE, [HARNESS_DESIGN])
    try {
      await writeEngineering([create('eva00'), put('eva01'), create('eva02')])
      await applyBoundaryWrites(harness.ctx, PILOT, HARNESS_DESIGN, [
        create('lilith'),
      ])

      const frames = await seele.readCommitFrames(PILOT, 0, carries('lilith'))

      expect(opsOf(frames)).toEqual([
        [{ action: 'create', path: pathOf('lilith') }],
      ])
      const pulled = await listRepoOps(
        harness.ctx,
        { did: PILOT, limit: 100, excludeValues: false },
        new Set([HARNESS_DESIGN]),
      )
      expect(pulled.ops.map((op) => op.rkey)).toEqual(['lilith'])
    } finally {
      await seele.close()
    }
  })

  it('leaves a taken-down record out of a multi-op event and still delivers the other ops', async () => {
    await writeEngineering([create('eva00'), create('eva01')])
    await writeEngineering([create('sachiel')])
    await takeDown('eva00')

    const frames = await magi.readCommitFrames(PILOT, 0, carries('sachiel'))

    expect(opsOf(frames)).toEqual([
      [{ action: 'create', path: pathOf('eva01') }],
      [{ action: 'create', path: pathOf('sachiel') }],
    ])
    const pulled = await pullEngineering(100)
    expect(pulled.ops.map((op) => op.rkey)).toEqual(['eva01', 'sachiel'])
  })

  it('skips an event whose only op is taken down', async () => {
    await writeEngineering([create('eva00')])
    await writeEngineering([create('sachiel')])
    await takeDown('eva00')

    const frames = await magi.readCommitFrames(PILOT, 0, carries('sachiel'))

    expect(opsOf(frames)).toEqual([
      [{ action: 'create', path: pathOf('sachiel') }],
    ])
  })
}

describe('boundary commit sync on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  defineBoundaryCommitSync(() => harness)
})

describe('boundary commit sync on postgres', () => {
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

  defineBoundaryCommitSync(() => harness)
})
