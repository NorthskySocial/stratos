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
