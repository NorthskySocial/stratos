import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeRecord } from '@northskysocial/stratos-core'
import { createSubscribeRecordsHandler } from '../src/subscription/subscribe-records.js'
import type { AppContext } from '../src/context.js'
import {
  ENGINEERING,
  GENERAL,
  settings,
  setup,
  type Harness,
} from './boundary-catalog/helpers.js'

const CONSUMER = 'did:web:bebop.example'
const AUTHOR = 'did:plc:spike'
const FAYE = 'did:plc:faye'
const credentials = { credentials: { type: 'service', iss: CONSUMER } }
type Stream = ReturnType<ReturnType<typeof createSubscribeRecordsHandler>>

interface EventRow {
  seq: number
  did: string
  sequencedAt: string
  event: Uint8Array
}

function post(seq: number, boundary = ENGINEERING): EventRow {
  return {
    seq,
    did: AUTHOR,
    sequencedAt: '1998-04-03T00:00:00Z',
    event: encodeRecord({
      rev: `rev${seq}`,
      ops: [
        {
          action: 'create',
          path: `zone.stratos.feed.post/bebop${seq}`,
          record: {
            text: `Bebop ${seq}`,
            boundary: { values: [{ value: boundary }] },
          },
        },
      ],
    }),
  }
}

describe('durable authorization of established sync streams', () => {
  let h: Harness
  let ctx: AppContext
  let events: EventRow[]
  let streams: Array<{ stream: Stream; controller: AbortController }>

  beforeEach(async () => {
    h = await setup()
    await h.enroll(CONSUMER, [ENGINEERING], true, true)
    await h.enroll(AUTHOR)
    events = [post(1), post(2)]
    streams = []
    const sequence = {
      getLatestSeq: async () => events.at(-1)?.seq ?? 0,
      getOldestSeq: async () => events[0]?.seq ?? 0,
      getEventsSince: async (cursor: number) =>
        events.filter((event) => event.seq > cursor),
    }
    ctx = {
      enrollmentStore: h.members,
      boundaryStore: h.store,
      enrollmentEvents: new EventEmitter(),
      sequenceEvents: new EventEmitter(),
      actorStore: {
        exists: async () => true,
        read: async (
          _did: string,
          read: (store: { sequence: typeof sequence }) => Promise<unknown>,
        ) => read({ sequence }),
      },
    } as unknown as AppContext
  })

  afterEach(async () => {
    for (const { controller } of streams) controller.abort()
    await Promise.all(streams.map(({ stream }) => stream.return(undefined)))
    vi.restoreAllMocks()
    await h.cleanup()
  })

  function open(params: { did?: string } = { did: AUTHOR }) {
    const controller = new AbortController()
    const stream = createSubscribeRecordsHandler(ctx)(
      params,
      credentials,
      controller.signal,
    )
    streams.push({ stream, controller })
    return { stream, controller }
  }

  async function cycleBoundary() {
    const current = await h.store.get(ENGINEERING)
    const inactive = await h.manager.deactivate(ENGINEERING, current!.revision)
    await h.manager.reactivate(ENGINEERING, inactive.revision)
    await h.members.addBoundary(AUTHOR, ENGINEERING)
  }

  it('closes a buffered actor replay after a durable membership removal without an event notification', async () => {
    const { stream } = open()
    expect((await stream.next()).value).toMatchObject({ seq: 1 })
    await h.members.removeBoundary(CONSUMER, ENGINEERING)
    await expect(stream.next()).rejects.toThrow(
      'Subscription authorization changed',
    )
    expect(ctx.enrollmentEvents.listenerCount('enrollment')).toBe(0)
  })

  it.each(['inactive', 'removed'] as const)(
    'closes when the caller enrollment becomes %s after admission',
    async (state) => {
      const { stream } = open()
      await stream.next()
      if (state === 'inactive')
        await h.members.updateEnrollment(CONSUMER, { active: false })
      else await h.members.unenroll(CONSUMER)
      await expect(stream.next()).rejects.toThrow(
        'Enrollment is missing or deactivated',
      )
    },
  )

  it('does not send a live actor commit after deactivation/reactivation without a new service grant', async () => {
    events = [post(1)]
    const { stream } = open()
    await stream.next()
    const next = stream.next()
    const rejected = expect(next).rejects.toThrow(
      'Subscription authorization changed',
    )
    await vi.waitFor(() =>
      expect(ctx.sequenceEvents.listenerCount(AUTHOR)).toBe(1),
    )
    await cycleBoundary()
    events.push(post(2))
    ctx.sequenceEvents.emit(AUTHOR)
    await rejected
    expect(ctx.sequenceEvents.listenerCount(AUTHOR)).toBe(0)
    expect(await h.members.getBoundaries(CONSUMER)).toEqual([GENERAL])
  })

  it.each(['replay', 'queued'] as const)(
    'reauthorizes service enrollment %s frames and removes its listener when revoked',
    async (mode) => {
      if (mode === 'replay') await h.enroll(FAYE)
      const { stream } = open({})
      expect((await stream.next()).value).toMatchObject({
        $type: 'zone.stratos.sync.subscribeRecords#enrollment',
      })
      if (mode === 'queued') {
        ctx.enrollmentEvents.emit('enrollment', {
          did: FAYE,
          action: 'enroll',
          boundaries: [ENGINEERING],
          time: '1998-04-03T00:00:00Z',
        })
      }
      await h.members.removeBoundary(CONSUMER, ENGINEERING)
      await expect(stream.next()).rejects.toThrow(
        'Subscription authorization changed',
      )
      expect(ctx.enrollmentEvents.listenerCount('enrollment')).toBe(0)
    },
  )

  it('detects a lifecycle change during the current-membership read even when that read returns the old set', async () => {
    const { stream } = open()
    await stream.next()
    const read = h.members.getBoundaries.bind(h.members)
    vi.spyOn(h.members, 'getBoundaries').mockImplementationOnce(async (did) => {
      const oldBoundaries = await read(did)
      await cycleBoundary()
      return oldBoundaries
    })
    await expect(stream.next()).rejects.toThrow(
      'Subscription authorization changed',
    )
  })

  it('requires reconnect after the held boundary revision changes, even when membership still exists', async () => {
    const { stream } = open()
    await stream.next()
    await h.manager.update(
      ENGINEERING,
      { ...settings, displayName: 'Pilots' },
      1,
    )
    await expect(stream.next()).rejects.toThrow(
      'Subscription authorization changed',
    )
  })

  it('rejects inactive definitions despite a stale membership adapter', async () => {
    const { stream } = open()
    await stream.next()
    const membership = await h.members.getBoundaries(CONSUMER)
    await h.store.beginDeactivation(ENGINEERING, 1)
    vi.spyOn(h.members, 'getBoundaries').mockResolvedValue(membership)
    await expect(stream.next()).rejects.toThrow(
      'Subscription authorization changed',
    )
  })

  it.each(['deactivating', 'inactive'] as const)(
    'rejects admission to an already %s definition even when membership reads are stale',
    async (status) => {
      if (status === 'deactivating')
        await h.store.beginDeactivation(ENGINEERING, 1)
      else await h.manager.deactivate(ENGINEERING, 1)
      vi.spyOn(h.members, 'getBoundaries').mockResolvedValue([
        ENGINEERING,
        GENERAL,
      ])
      const { stream } = open()
      await expect(stream.next()).rejects.toThrow(
        'Subscription authorization changed',
      )
    },
  )

  it('never admits a catalog-absent boundary from a stale membership adapter', async () => {
    vi.spyOn(h.members, 'getBoundaries').mockResolvedValue([
      ENGINEERING,
      `${GENERAL}-missing`,
    ])
    const { stream } = open()
    await expect(stream.next()).rejects.toThrow(
      'Subscription authorization changed',
    )
  })

  it('fails closed if the catalog disappears after admission', async () => {
    const { stream } = open()
    await stream.next()
    ctx.boundaryStore = undefined
    await expect(stream.next()).rejects.toThrow(
      'Subscription authorization changed',
    )
  })

  it('ends the stream on durable authorization read failure instead of using its admitted snapshot', async () => {
    const { stream } = open()
    await stream.next()
    vi.spyOn(h.store, 'list').mockRejectedValue(
      new Error('Catalog unavailable'),
    )
    await expect(stream.next()).rejects.toThrow('Catalog unavailable')
  })

  it('honors abort while checking a prepared frame', async () => {
    const { stream, controller } = open()
    await stream.next()
    const read = h.members.getEnrollment.bind(h.members)
    vi.spyOn(h.members, 'getEnrollment').mockImplementationOnce(async (did) => {
      const result = await read(did)
      controller.abort()
      return result
    })
    expect(await stream.next()).toEqual({ done: true, value: undefined })
  })

  it('does not widen a running actor stream after adding a boundary or changing unrelated definitions', async () => {
    const design = GENERAL.replace('/general', '/design')
    events = [post(1), post(2, design), post(3)]
    const { stream } = open()
    await stream.next()
    await h.members.addBoundary(CONSUMER, design)
    await h.manager.update(design, settings, 1)
    expect((await stream.next()).value).toMatchObject({ seq: 3 })
  })

  it('preserves enrollment replay for authors in both custody modes', async () => {
    await h.enroll(FAYE)
    await h.members.updateEnrollment(FAYE, {
      custody: 'pds',
      repoHost: 'https://bebop.example',
    })
    const { stream } = open({})
    const first = (await stream.next()).value
    const second = (await stream.next()).value
    expect([first, second]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          did: AUTHOR,
          boundaries: expect.arrayContaining([ENGINEERING]),
        }),
        expect.objectContaining({
          did: FAYE,
          boundaries: expect.arrayContaining([ENGINEERING]),
        }),
      ]),
    )
  })
})
