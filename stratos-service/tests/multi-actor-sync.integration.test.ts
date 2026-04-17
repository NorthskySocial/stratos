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

describe('Multi-Actor Sync Integration', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let enrollmentStore: SqliteEnrollmentStore
  let db: ServiceDb
  let ctx: any
  let sequenceEvents: EventEmitter
  let enrollmentEvents: EventEmitter

  const serviceDid = 'did:web:nerv.tokyo.jp'
  const aliceDid = 'did:plc:alice-braun'
  const bobDid = 'did:plc:bob-makihara'

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-multi-sync-test-${randomBytes(8).toString('hex')}`,
    )
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

  it('should handle events from multiple actors in their respective streams', async () => {
    await actorStore.create(aliceDid)
    await actorStore.create(bobDid)

    const handler = createSubscribeRecordsHandler(ctx)

    // Create events for Alice
    const aliceEvent = encodeRecord({
      rev: 'alice-rev-1',
      ops: [
        {
          action: 'create',
          path: 'zone.stratos.feed.post/1',
          record: { text: 'Alice post' },
        },
      ],
    })
    await actorStore.transact(aliceDid, async (store) => {
      await store.sequence.appendEvent({
        did: aliceDid,
        eventType: 'create',
        event: Buffer.from(aliceEvent),
        invalidated: 0,
        sequencedAt: new Date().toISOString(),
      })
    })

    // Create events for Bob
    const bobEvent = encodeRecord({
      rev: 'bob-rev-1',
      ops: [
        {
          action: 'create',
          path: 'zone.stratos.feed.post/1',
          record: { text: 'Bob post' },
        },
      ],
    })
    await actorStore.transact(bobDid, async (store) => {
      await store.sequence.appendEvent({
        did: bobDid,
        eventType: 'create',
        event: Buffer.from(bobEvent),
        invalidated: 0,
        sequencedAt: new Date().toISOString(),
      })
    })

    // Subscribe to Alice's stream
    const aliceAbort = new AbortController()
    const aliceGen = handler(
      { did: aliceDid },
      { credentials: { type: 'owner', did: aliceDid } },
      aliceAbort.signal,
    )

    const aliceFirst = await aliceGen.next()
    expect(aliceFirst.done).toBe(false)
    expect((aliceFirst.value as any).did).toBe(aliceDid)
    expect((aliceFirst.value as any).rev).toBe('alice-rev-1')

    // Subscribe to Bob's stream
    const bobAbort = new AbortController()
    const bobGen = handler(
      { did: bobDid },
      { credentials: { type: 'owner', did: bobDid } },
      bobAbort.signal,
    )

    const bobFirst = await bobGen.next()
    expect(bobFirst.done).toBe(false)
    expect((bobFirst.value as any).did).toBe(bobDid)
    expect((bobFirst.value as any).rev).toBe('bob-rev-1')

    aliceAbort.abort()
    bobAbort.abort()
  })

  it('should handle service-level enrollment events', async () => {
    const handler = createSubscribeRecordsHandler(ctx)
    const abort = new AbortController()

    // Service-level subscription requires service auth
    const gen = handler(
      {},
      { credentials: { type: 'service', did: serviceDid } },
      abort.signal,
    )

    // Initially, there should be no enrollments
    // Let's create an enrollment and see if it's replayed/streamed
    const aliceEnrollment = {
      did: aliceDid,
      enrolledAt: new Date().toISOString(),
      active: true,
      service: 'https://stratos.test',
      pdsEndpoint: 'https://pds.test',
      signingKeyDid: 'did:key:zQ3sh...',
      enrollmentRkey: 'abc-123',
    }
    await enrollmentStore.enroll(aliceEnrollment)

    const first = await gen.next()
    expect(first.done).toBe(false)
    expect((first.value as any).$type).toBe(
      'zone.stratos.sync.subscribeRecords#enrollment',
    )
    expect((first.value as any).did).toBe(aliceDid)

    abort.abort()
  })

  it('should resume from cursor correctly for multiple actors', async () => {
    await actorStore.create(aliceDid)
    await actorStore.create(bobDid)

    const handler = createSubscribeRecordsHandler(ctx)

    // Alice Event 1 (Seq 1)
    await actorStore.transact(aliceDid, async (store) => {
      await store.sequence.appendEvent({
        did: aliceDid,
        eventType: 'create',
        event: Buffer.from(
          encodeRecord({
            ops: [
              {
                action: 'create',
                path: 'zone.stratos.feed.post/a1',
                record: {},
              },
            ],
            rev: 'a1',
          }),
        ),
        invalidated: 0,
        sequencedAt: new Date().toISOString(),
      })
    })
    // Alice Event 2 (Seq 2)
    await actorStore.transact(aliceDid, async (store) => {
      await store.sequence.appendEvent({
        did: aliceDid,
        eventType: 'create',
        event: Buffer.from(
          encodeRecord({
            ops: [
              {
                action: 'create',
                path: 'zone.stratos.feed.post/a2',
                record: {},
              },
            ],
            rev: 'a2',
          }),
        ),
        invalidated: 0,
        sequencedAt: new Date().toISOString(),
      })
    })

    // Bob Event 1 (Seq 1)
    await actorStore.transact(bobDid, async (store) => {
      await store.sequence.appendEvent({
        did: bobDid,
        eventType: 'create',
        event: Buffer.from(
          encodeRecord({
            ops: [
              {
                action: 'create',
                path: 'zone.stratos.feed.post/b1',
                record: {},
              },
            ],
            rev: 'b1',
          }),
        ),
        invalidated: 0,
        sequencedAt: new Date().toISOString(),
      })
    })

    // Resume Alice from Seq 0
    const aliceAbort = new AbortController()
    const aliceGen = handler(
      { did: aliceDid, cursor: 0 },
      { credentials: { type: 'owner', did: aliceDid } },
      aliceAbort.signal,
    )

    const aliceInfo = await aliceGen.next()
    expect(aliceInfo.done).toBe(false)
    expect((aliceInfo.value as any).$type).toBe(
      'zone.stratos.sync.subscribeRecords#info',
    )
    expect((aliceInfo.value as any).name).toBe('OutdatedCursor')

    const aliceResumed = await aliceGen.next()
    expect(aliceResumed.done).toBe(false)
    expect((aliceResumed.value as any).seq).toBe(1)
    expect((aliceResumed.value as any).rev).toBe('a1')

    // Resume Bob from Seq 0 (Bob's first event was Seq 1)
    const bobAbort = new AbortController()
    const bobGen = handler(
      { did: bobDid, cursor: 0 },
      { credentials: { type: 'owner', did: bobDid } },
      bobAbort.signal,
    )

    const bobInfo = await bobGen.next()
    expect(bobInfo.done).toBe(false)
    expect((bobInfo.value as any).$type).toBe(
      'zone.stratos.sync.subscribeRecords#info',
    )

    const bobResumed = await bobGen.next()
    expect(bobResumed.done).toBe(false)
    expect((bobResumed.value as any).seq).toBe(1)
    expect((bobResumed.value as any).rev).toBe('b1')

    aliceAbort.abort()
    bobAbort.abort()
  })
})
