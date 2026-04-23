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
    it('should stream actor records for owner', async () => {
      await actorStore.create(testDid)
      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()

      // Add an event
      const eventData = encodeRecord({
        rev: 'rev1',
        ops: [
          {
            action: 'create',
            path: 'zone.stratos.feed.post/1',
            record: { text: 'Hello' },
          },
        ],
      })
      await actorStore.transact(testDid, async (store: any) => {
        await store.sequence.appendEvent({
          did: testDid,
          eventType: 'append',
          event: eventData,
          invalidated: 0,
          sequencedAt: new Date().toISOString(),
        })
      })

      const generator = handler(
        { did: testDid },
        { credentials: { type: 'owner', did: testDid } },
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

    it('should stream actor records for service', async () => {
      await actorStore.create(testDid)
      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()

      const generator = handler(
        { did: testDid },
        { credentials: { type: 'service' } },
        abortController.signal,
      )

      // Should not throw AuthRequiredError
      const promise = generator.next()

      // Clean up
      abortController.abort()
      await promise.catch(() => {})
    })

    it('should throw AuthRequiredError for unauthorized actor access', async () => {
      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()

      const generator = handler(
        { did: testDid },
        { credentials: { type: 'owner', did: 'did:plc:other' } },
        abortController.signal,
      )

      await expect(generator.next()).rejects.toThrow(
        'Service auth or owner authentication required',
      )
    })

    it('should stream service enrollment events', async () => {
      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()

      // Enroll someone
      const enrollmentTime = new Date().toISOString()
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: enrollmentTime,
        active: true,
        signingKeyDid: 'did:key:zDnae',
      })

      const generator = handler(
        {},
        { credentials: { type: 'service' } },
        abortController.signal,
      )

      const first = await generator.next()
      expect(first.done).toBe(false)
      expect(first.value.$type).toBe(
        'zone.stratos.sync.subscribeRecords#enrollment',
      )
      expect((first.value as any).did).toBe(testDid)
      expect((first.value as any).action).toBe('enroll')

      abortController.abort()
    })

    it('should throw AuthRequiredError for unauthorized service access', async () => {
      const handler = createSubscribeRecordsHandler(ctx) as any
      const abortController = new AbortController()

      const generator = handler(
        {},
        { credentials: { type: 'owner', did: testDid } },
        abortController.signal,
      )

      await expect(generator.next()).rejects.toThrow(
        'Service auth required for service-level subscription',
      )
    })
  })
})
