import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { encodeRecord } from '@northskysocial/stratos-core'
import { decode } from '@atcute/cbor'
import { EventEmitter } from 'events'

import { SqliteEnrollmentStore, StratosActorStore } from '../src/context.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db/index.js'
import { createSubscribeRecordsHandler } from '../src/subscription/index.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'

describe('Subscription Handlers', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let enrollmentStore: SqliteEnrollmentStore
  let db: ServiceDb
  let ctx: any
  let sequenceEvents: EventEmitter
  let enrollmentEvents: EventEmitter

  const testDid = 'did:plc:shinji-ikari'
  const serviceDid = 'did:web:nerv.tokyo.jp'

  beforeEach(async () => {
    dataDir = join(tmpdir(), `stratos-test-${randomBytes(8).toString('hex')}`)
    await mkdir(dataDir, { recursive: true })

    const cfg = createTestConfig(dataDir)
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)

    enrollmentStore = new SqliteEnrollmentStore(db)
    actorStore = new StratosActorStore({
      dataDir,
      blobstore: () => createMockBlobStore(),
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })

    sequenceEvents = new EventEmitter()
    enrollmentEvents = new EventEmitter()

    ctx = {
      cfg,
      actorStore,
      enrollmentStore,
      serviceDid,
      sequenceEvents,
      enrollmentEvents,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
    }
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  describe('createSubscribeRecordsHandler', () => {
    const serviceCreds = {
      credentials: { type: 'service', iss: serviceDid, did: serviceDid },
    }

    async function enrollService(boundaries: string[]) {
      await enrollmentStore.enroll({
        did: serviceDid,
        enrolledAt: new Date().toISOString(),
        active: true,
        signingKeyDid: serviceDid,
        isService: true,
      })
      await enrollmentStore.setBoundaries(serviceDid, boundaries)
    }

    async function enrollUser(did: string, boundaries: string[]) {
      await enrollmentStore.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        active: true,
        signingKeyDid: 'did:key:zDnae',
      })
      await enrollmentStore.setBoundaries(did, boundaries)
    }

    async function appendPost(
      did: string,
      path: string,
      boundary: string,
      text: string,
    ) {
      const eventData = encodeRecord({
        rev: 'rev1',
        ops: [
          {
            action: 'create',
            path,
            record: {
              text,
              boundary: { values: [{ value: boundary }] },
            },
          },
        ],
      })
      await actorStore.transact(did, async (store: any) => {
        await store.sequence.appendEvent({
          did,
          eventType: 'append',
          event: eventData,
          invalidated: 0,
          sequencedAt: new Date().toISOString(),
        })
      })
    }

    /**
     * Append one event per entry of `boundaries`, so a drained page can mix
     * in-scope and out-of-scope events.
     */
    async function appendEvents(did: string, boundaries: string[]) {
      await actorStore.transact(did, async (store: any) => {
        for (const [offset, boundary] of boundaries.entries()) {
          const index = offset + 1
          await store.sequence.appendEvent({
            did,
            eventType: 'append',
            event: encodeRecord({
              rev: `rev${index}`,
              ops: [
                {
                  action: 'create',
                  path: `zone.stratos.feed.post/${index}`,
                  record: {
                    text: `Angel sighting ${index}`,
                    boundary: { values: [{ value: boundary }] },
                  },
                },
              ],
            }),
            invalidated: 0,
            sequencedAt: new Date().toISOString(),
          })
        }
      })
    }

    async function collect(generator: any, count: number): Promise<any[]> {
      const messages: any[] = []
      for (let i = 0; i < count; i++) {
        const next = await generator.next()
        if (next.done) break
        messages.push(next.value)
      }
      return messages
    }

    function paths(messages: any[]): string[] {
      return messages.map((message) => message.ops[0].path)
    }

    /**
     * `count` in-scope events with a single out-of-scope 'seele' event in the
     * middle, so a filtered-out event inside a drained page would surface as an
     * `undefined` frame rather than being silently skipped.
     */
    function backlogBoundaries(count: number, boundary: string): string[] {
      const boundaries = Array.from({ length: count + 1 }, () => boundary)
      boundaries[Math.floor(count / 2)] = 'seele'
      return boundaries
    }

    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    /**
     * A ctx whose actor-store reads are counted, so a drain loop that never
     * exits shows up as reads accruing while the stream should be parked.
     */
    function countingCtx() {
      const counter = { reads: 0 }
      return {
        counter,
        ctx: {
          ...ctx,
          actorStore: {
            exists: (did: string) => actorStore.exists(did),
            read: (did: string, fn: any) => {
              counter.reads++
              return actorStore.read(did, fn)
            },
          },
        },
      }
    }

    /**
     * Assert the stream parked on the wake wait instead of spinning on the
     * store: a fully drained stream issues no further reads until a new event,
     * and closes cleanly when the connection aborts.
     */
    async function expectParkedOnWake(
      generator: any,
      counter: { reads: number },
      abortController: AbortController,
    ) {
      const pending = generator.next()
      await sleep(60)
      const readsWhileIdle = counter.reads
      await sleep(60)
      expect(counter.reads).toBe(readsWhileIdle)

      abortController.abort()
      expect((await pending).done).toBe(true)
    }

    it('streams in-boundary actor records to an enrolled service', async () => {
      await enrollService(['nerv'])
      await actorStore.create(testDid)
      await appendPost(testDid, 'zone.stratos.feed.post/1', 'nerv', 'Hello')

      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()
      const generator = handler(
        { did: testDid },
        serviceCreds,
        abortController.signal,
      )

      const first = await generator.next()
      expect(first.done).toBe(false)
      expect(first.value.$type).toBe(
        'zone.stratos.sync.subscribeRecords#commit',
      )
      expect((first.value as any).ops[0].path).toBe('zone.stratos.feed.post/1')

      abortController.abort()
    })

    it('drops actor records outside the service boundaries', async () => {
      await enrollService(['nerv'])
      await actorStore.create(testDid)
      await appendPost(testDid, 'zone.stratos.feed.post/1', 'seele', 'secret')

      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()
      const generator = handler(
        { did: testDid },
        serviceCreds,
        abortController.signal,
      )

      const nextPromise = generator.next()
      abortController.abort()
      const result = await nextPromise
      expect(result.done).toBe(true)
    })

    it('narrows actor records by domain within shared boundaries', async () => {
      await enrollService(['nerv', 'seele'])
      await actorStore.create(testDid)
      await appendPost(testDid, 'zone.stratos.feed.post/1', 'seele', 'secret')

      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()
      const generator = handler(
        { did: testDid, domain: 'nerv' },
        serviceCreds,
        abortController.signal,
      )

      const nextPromise = generator.next()
      abortController.abort()
      const result = await nextPromise
      expect(result.done).toBe(true)
    })

    it('drops undecodable actor events (fail closed)', async () => {
      await enrollService(['nerv'])
      await actorStore.create(testDid)
      await actorStore.transact(testDid, async (store: any) => {
        await store.sequence.appendEvent({
          did: testDid,
          eventType: 'append',
          event: new Uint8Array([0xff, 0xfe, 0xfd]),
          invalidated: 0,
          sequencedAt: new Date().toISOString(),
        })
      })

      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()
      const generator = handler(
        { did: testDid },
        serviceCreds,
        abortController.signal,
      )

      const nextPromise = generator.next()
      abortController.abort()
      const result = await nextPromise
      expect(result.done).toBe(true)
    })

    it('holds the stream open for an actor without a store', async () => {
      await enrollService(['nerv'])
      await enrollUser(testDid, ['nerv'])
      // Note: no actorStore.create(testDid) — the actor has enrolled but has
      // not written a record yet, so it has no per-actor store.

      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()
      const generator = handler(
        { did: testDid },
        serviceCreds,
        abortController.signal,
      )

      const nextPromise = generator.next()
      abortController.abort()
      const result = await nextPromise
      // Previously this threw NotFound; now it stays open and returns cleanly
      // when aborted.
      expect(result.done).toBe(true)
    })

    it('streams the first record once a previously-absent store is created', async () => {
      await enrollService(['nerv'])
      await enrollUser(testDid, ['nerv'])

      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()
      const generator = handler(
        { did: testDid },
        serviceCreds,
        abortController.signal,
      )

      // Enters the hold-open path and waits for the store to appear.
      const firstPromise = generator.next()

      // The actor's first write creates the store and appends an event.
      await actorStore.create(testDid)
      await appendPost(testDid, 'zone.stratos.feed.post/1', 'nerv', 'Hello')

      // Wake the waiting stream; poll to avoid a listener-registration race.
      const wake = setInterval(() => sequenceEvents.emit(testDid), 5)
      const first = await firstPromise
      clearInterval(wake)

      expect(first.done).toBe(false)
      expect(first.value.$type).toBe(
        'zone.stratos.sync.subscribeRecords#commit',
      )
      expect((first.value as any).ops[0].path).toBe('zone.stratos.feed.post/1')

      abortController.abort()
    })

    it('resumes from latest instead of rejecting a future cursor', async () => {
      await enrollService(['nerv'])
      await actorStore.create(testDid)
      await appendPost(testDid, 'zone.stratos.feed.post/1', 'nerv', 'first')

      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()
      const generator = handler(
        { did: testDid, cursor: 999 },
        serviceCreds,
        abortController.signal,
      )

      const nextPromise = generator.next()
      abortController.abort()
      const result = await nextPromise

      // Previously this threw FutureCursor; now it clamps to latest and waits.
      expect(result.done).toBe(true)
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ did: testDid, cursor: 999, latestSeq: 1 }),
        expect.stringContaining('cursor ahead of latest'),
      )
    })

    // The drain tests are bounded well under the stream's 30 s wake timeout: a
    // regression that reverts to one page per wake must fail fast rather than
    // stall CI for half a minute per page.
    it('drains a backlog larger than one page on connect', async () => {
      await enrollService(['nerv'])
      await actorStore.create(testDid)
      await appendEvents(testDid, backlogBoundaries(150, 'nerv'))

      const { ctx: readCountingCtx, counter } = countingCtx()
      const handler = createSubscribeRecordsHandler(readCountingCtx) as any
      const abortController = new AbortController()
      const generator = handler(
        { did: testDid },
        serviceCreds,
        abortController.signal,
      )

      const messages = await collect(generator, 150)
      // The backlog is exhausted, so the stream must park rather than keep
      // re-reading the store.
      await expectParkedOnWake(generator, counter, abortController)

      expect(messages).toHaveLength(150)
      expect(paths(messages).at(0)).toBe('zone.stratos.feed.post/1')
      expect(paths(messages).at(-1)).toBe('zone.stratos.feed.post/151')
      expect(paths(messages)).not.toContain('zone.stratos.feed.post/76')
    }, 10_000)

    it('drains more than one page per wake', async () => {
      await enrollService(['nerv'])
      await actorStore.create(testDid)

      const { ctx: readCountingCtx, counter } = countingCtx()
      const handler = createSubscribeRecordsHandler(readCountingCtx) as any
      const abortController = new AbortController()
      const generator = handler(
        { did: testDid },
        serviceCreds,
        abortController.signal,
      )

      // Wait until the stream has actually parked on the wake wait before
      // appending. If catch-up ever saw the events, the connect drain would
      // serve them all and this test would silently stop covering the
      // per-wake multi-page drain it is named for.
      const parked = new Promise<void>((resolve) =>
        sequenceEvents.once('newListener', (event) => {
          if (event === testDid) resolve()
        }),
      )
      const firstPromise = generator.next()
      await parked
      await appendEvents(testDid, backlogBoundaries(120, 'nerv'))
      sequenceEvents.emit(testDid)
      const first = await firstPromise

      const rest = await collect(generator, 119)
      await expectParkedOnWake(generator, counter, abortController)

      const messages = [first.value, ...rest]
      expect(messages).toHaveLength(120)
      expect(paths(messages).at(0)).toBe('zone.stratos.feed.post/1')
      expect(paths(messages).at(-1)).toBe('zone.stratos.feed.post/121')
      expect(paths(messages)).not.toContain('zone.stratos.feed.post/61')
    }, 10_000)

    it('stops draining a backlog once the connection aborts', async () => {
      await enrollService(['nerv'])
      await actorStore.create(testDid)
      await appendEvents(testDid, backlogBoundaries(150, 'nerv'))

      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()
      const generator = handler(
        { did: testDid },
        serviceCreds,
        abortController.signal,
      )

      const first = await generator.next()
      expect(first.done).toBe(false)

      abortController.abort()
      const afterAbort = await generator.next()
      expect(afterAbort.done).toBe(true)
    }, 10_000)

    it('stops draining a post-wake page once the connection aborts', async () => {
      await enrollService(['nerv'])
      await actorStore.create(testDid)

      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()
      const generator = handler(
        { did: testDid },
        serviceCreds,
        abortController.signal,
      )

      // Park before appending so the page is delivered by the post-wake
      // drain, not the connect catch-up (see 'drains more than one page per
      // wake' above).
      const parked = new Promise<void>((resolve) =>
        sequenceEvents.once('newListener', (event) => {
          if (event === testDid) resolve()
        }),
      )
      const firstPromise = generator.next()
      await parked
      await appendEvents(testDid, backlogBoundaries(120, 'nerv'))
      sequenceEvents.emit(testDid)
      const first = await firstPromise
      expect(first.done).toBe(false)

      // Aborting mid-page must end the stream, not deliver the page's tail.
      abortController.abort()
      const afterAbort = await generator.next()
      expect(afterAbort.done).toBe(true)
    }, 10_000)

    it('ends the connection when a sequence read fails instead of replaying from zero', async () => {
      await enrollService(['nerv'])
      const failingCtx = {
        ...ctx,
        actorStore: {
          exists: async () => true,
          read: async () => {
            throw new Error('MAGI sequence store unreachable')
          },
        },
      }

      const handler = createSubscribeRecordsHandler(failingCtx) as any
      const abortController = new AbortController()
      const generator = handler(
        { did: testDid, cursor: 42 },
        serviceCreds,
        abortController.signal,
      )

      await expect(generator.next()).rejects.toThrow(
        'MAGI sequence store unreachable',
      )
      abortController.abort()

      // A swallowed read error used to report latestSeq 0, which made any
      // live cursor look "ahead of latest" and silently replayed the client
      // from the start of the log.
      const resumedFromLatest = failingCtx.logger.warn.mock.calls.some(
        ([, message]: [unknown, unknown]) =>
          typeof message === 'string' &&
          message.includes('cursor ahead of latest'),
      )
      expect(resumedFromLatest).toBe(false)

      // The failure must reach the operator log, not just the client, and
      // must carry enough context to identify the actor.
      const failureWarn = failingCtx.logger.warn.mock.calls.find(
        ([, message]: [unknown, unknown]) => message === 'getLatestSeq failed',
      )
      expect(failureWarn?.[0]).toMatchObject({
        did: testDid,
        err: expect.any(Error),
      })
    }, 5_000)

    it('rethrows a sequence read failure untouched when no logger is configured', async () => {
      await enrollService(['nerv'])
      const { logger: _logger, ...bareCtx } = ctx
      const failingCtx = {
        ...bareCtx,
        actorStore: {
          exists: async () => true,
          read: async () => {
            throw new Error('MAGI sequence store unreachable')
          },
        },
      }

      const handler = createSubscribeRecordsHandler(failingCtx) as any
      const abortController = new AbortController()
      const generator = handler(
        { did: testDid, cursor: 42 },
        serviceCreds,
        abortController.signal,
      )

      // The warn hardening must not replace the store error with a crash on
      // the missing logger.
      await expect(generator.next()).rejects.toThrow(
        'MAGI sequence store unreachable',
      )
      abortController.abort()
    }, 5_000)

    it('keeps the connection when only the oldest-seq probe fails, and warns', async () => {
      await enrollService(['nerv'])
      const flakyCtx = {
        ...ctx,
        actorStore: {
          exists: async () => true,
          read: async (_did: string, fn: (store: unknown) => unknown) =>
            fn({
              sequence: {
                getLatestSeq: async () => 7,
                getOldestSeq: async () => {
                  throw new Error('MAGI oldest-seq probe offline')
                },
                getEventsSince: async () => [],
              },
            }),
        },
      }

      const handler = createSubscribeRecordsHandler(flakyCtx) as any
      const abortController = new AbortController()
      // Pre-abort so the generator runs the connect sequence and returns
      // without parking in the live-stream wait.
      abortController.abort()
      const generator = handler(
        { did: testDid, cursor: 0 },
        serviceCreds,
        abortController.signal,
      )

      // A fabricated oldest of 0 suppresses the OutdatedCursor advisory
      // (cursor 0 is not < 0), so the stream ends cleanly with no frames —
      // it must not reject.
      const first = await generator.next()
      expect(first.done).toBe(true)

      const oldestSeqWarn = flakyCtx.logger.warn.mock.calls.find(
        ([, message]: [unknown, unknown]) => message === 'getOldestSeq failed',
      )
      expect(oldestSeqWarn?.[0]).toMatchObject({
        did: testDid,
        err: expect.any(Error),
      })
    }, 5_000)

    it('ends the connection and warns when the catch-up page read fails', async () => {
      await enrollService(['nerv'])
      const failingCtx = {
        ...ctx,
        actorStore: {
          exists: async () => true,
          read: async (_did: string, fn: (store: unknown) => unknown) =>
            fn({
              sequence: {
                getLatestSeq: async () => 5,
                getOldestSeq: async () => 1,
                getEventsSince: async () => {
                  throw new Error('MAGI event page unreachable')
                },
              },
            }),
        },
      }

      const handler = createSubscribeRecordsHandler(failingCtx) as any
      const abortController = new AbortController()
      const generator = handler(
        { did: testDid, cursor: 2 },
        serviceCreds,
        abortController.signal,
      )

      await expect(generator.next()).rejects.toThrow(
        'MAGI event page unreachable',
      )
      abortController.abort()

      const pageReadWarn = failingCtx.logger.warn.mock.calls.find(
        ([, message]: [unknown, unknown]) =>
          message === 'getEventsSince failed',
      )
      expect(pageReadWarn?.[0]).toMatchObject({
        did: testDid,
        cursor: 2,
        err: expect.any(Error),
      })
    }, 5_000)

    it('propagates benign and fatal read failures correctly with no logger', async () => {
      await enrollService(['nerv'])
      const { logger: _logger, ...bareCtx } = ctx
      const failingCtx = {
        ...bareCtx,
        actorStore: {
          exists: async () => true,
          read: async (_did: string, fn: (store: unknown) => unknown) =>
            fn({
              sequence: {
                getLatestSeq: async () => 7,
                getOldestSeq: async () => {
                  throw new Error('MAGI oldest-seq probe offline')
                },
                getEventsSince: async () => {
                  throw new Error('MAGI event page unreachable')
                },
              },
            }),
        },
      }

      const handler = createSubscribeRecordsHandler(failingCtx) as any
      const abortController = new AbortController()
      const generator = handler(
        { did: testDid, cursor: 0 },
        serviceCreds,
        abortController.signal,
      )

      // The oldest-seq failure stays benign (no crash on the missing logger)
      // and the connection then dies on the page-read error, not a TypeError.
      await expect(generator.next()).rejects.toThrow(
        'MAGI event page unreachable',
      )
      abortController.abort()
    }, 5_000)

    it('rejects non-service credentials', async () => {
      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()

      const generator = handler(
        { did: testDid },
        { credentials: { type: 'user', did: testDid } },
        abortController.signal,
      )

      await expect(generator.next()).rejects.toThrow('Service auth required')
    })

    it('rejects a service enrolled in no boundaries', async () => {
      await enrollmentStore.enroll({
        did: serviceDid,
        enrolledAt: new Date().toISOString(),
        active: true,
        signingKeyDid: serviceDid,
        isService: true,
      })

      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()
      const generator = handler({}, serviceCreds, abortController.signal)

      await expect(generator.next()).rejects.toThrow(
        'not enrolled in any boundary',
      )
    })

    it('replays shared-boundary users to a service', async () => {
      await enrollService(['nerv'])
      await enrollUser(testDid, ['nerv'])

      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()
      const generator = handler({}, serviceCreds, abortController.signal)

      const first = await generator.next()
      expect(first.done).toBe(false)
      expect(first.value.$type).toBe(
        'zone.stratos.sync.subscribeRecords#enrollment',
      )
      expect((first.value as any).did).toBe(testDid)
      expect((first.value as any).action).toBe('enroll')

      abortController.abort()
    })

    it('excludes non-shared-boundary users from service replay', async () => {
      await enrollService(['nerv'])
      await enrollUser('did:plc:kaworu-nagisa', ['seele'])

      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()
      const generator = handler({}, serviceCreds, abortController.signal)

      const nextPromise = generator.next()
      abortController.abort()
      const result = await nextPromise
      expect(result.done).toBe(true)
    })

    it('excludes peer service rows from service replay', async () => {
      await enrollService(['nerv'])
      // A peer service sharing the boundary must still be excluded.
      await enrollmentStore.enroll({
        did: 'did:web:seele.peer',
        enrolledAt: new Date().toISOString(),
        active: true,
        signingKeyDid: 'did:web:seele.peer',
        isService: true,
      })
      await enrollmentStore.setBoundaries('did:web:seele.peer', ['nerv'])

      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()
      const generator = handler({}, serviceCreds, abortController.signal)

      const nextPromise = generator.next()
      abortController.abort()
      const result = await nextPromise
      expect(result.done).toBe(true)
    })
  })
})
