import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { decode } from '@atcute/cbor'
import {
  computeCid,
  encodeRecord,
  stratosRecordBoundary,
} from '@northskysocial/stratos-core'

import { StratosActorStore } from '../src/context.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db/index.js'
import { applyWritesBatch } from '../src/api/records/index.js'
import { decodeEvent, type SeqEvent } from '../src/subscription/index.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'

const SERVICE_DID = 'did:web:nerv.tokyo.jp'
const ENGINEERING = `${SERVICE_DID}/engineering`
const DESIGN = `${SERVICE_DID}/design`
const COLLECTION = 'zone.stratos.feed.post'
const RKEY = 'unit02'

function post(boundary: string, text: string) {
  return {
    $type: COLLECTION,
    text,
    createdAt: new Date().toISOString(),
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: [{ value: boundary }],
    },
  }
}

describe('Batch indexes each op under its own authorized boundary', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let db: ServiceDb
  let ctx: any

  const testDid = 'did:plc:asuka-langley'

  async function storedBoundaries() {
    const rows = await actorStore.read(testDid, (store) =>
      (
        store.record as unknown as {
          reader: {
            db: {
              select: () => {
                from: (
                  table: unknown,
                ) => Promise<Array<{ recordUri: string; boundary: string }>>
              }
            }
          }
        }
      ).reader.db
        .select()
        .from(stratosRecordBoundary),
    )
    const byRkey: Record<string, string[]> = {}
    for (const row of rows) {
      const rkey = row.recordUri.split('/').pop()!
      ;(byRkey[rkey] ??= []).push(row.boundary)
    }
    return byRkey
  }

  async function readSeqEvents(): Promise<SeqEvent[]> {
    return actorStore.read(testDid, async (store: any) => {
      const rows = await store.sequence.getEventsSince(0, 1000)
      return rows.map(
        (row: any): SeqEvent => ({
          seq: row.seq,
          did: row.did,
          time: row.sequencedAt,
          rev: '',
          event: row.event,
        }),
      )
    })
  }

  function spyOnIndexing() {
    const indexInBoundary = vi.fn()
    const indexFromBody = vi.fn()
    const originalTransact = actorStore.transact.bind(actorStore)
    vi.spyOn(actorStore, 'transact').mockImplementation(((
      did: string,
      fn: (store: any) => Promise<unknown>,
    ) =>
      originalTransact(did, (store) => {
        const record = store.record
        const inBoundary = record.indexRecordInBoundary.bind(record)
        const fromBody = record.indexRecord.bind(record)
        record.indexRecordInBoundary = (
          ...args: Parameters<typeof inBoundary>
        ) => {
          indexInBoundary(...args)
          return inBoundary(...args)
        }
        record.indexRecord = (...args: Parameters<typeof fromBody>) => {
          indexFromBody(...args)
          return fromBody(...args)
        }
        return fn(store)
      })) as typeof actorStore.transact)
    return { indexInBoundary, indexFromBody }
  }

  function batch(
    ...ops: Array<{
      action: 'create' | 'update'
      rkey: string
      record: Record<string, unknown>
    }>
  ) {
    return applyWritesBatch(
      ctx,
      testDid,
      ops.map((op) => ({ ...op, collection: COLLECTION })),
    )
  }

  beforeEach(async () => {
    dataDir = join(tmpdir(), `stratos-test-${randomBytes(8).toString('hex')}`)
    await mkdir(dataDir, { recursive: true })

    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)

    actorStore = new StratosActorStore({
      dataDir,
      blobstore: () => createMockBlobStore() as any,
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })

    ctx = {
      cfg: createTestConfig(dataDir),
      actorStore,
      enrollmentStore: {
        getEnrollment: vi
          .fn()
          .mockResolvedValue({ active: true, isService: false }),
      },
      serviceDid: SERVICE_DID,
      writeRateLimiter: { assertWriteAllowed: vi.fn() },
      actorSigner: {
        sign: vi.fn().mockResolvedValue(new Uint8Array(64)),
        getSignFn: vi
          .fn()
          .mockResolvedValue(() => Promise.resolve(new Uint8Array(64))),
        getPublicKey: vi.fn().mockResolvedValue('did:key:zDnaeTestKey'),
        ensureKey: vi.fn().mockResolvedValue(undefined),
      },
      repoWriteLocks: { acquire: vi.fn().mockResolvedValue(() => {}) },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
      sequenceEvents: { emit: vi.fn() },
      boundaryResolver: {
        getBoundaries: vi.fn().mockResolvedValue([ENGINEERING, DESIGN]),
      },
    }

    await actorStore.create(testDid)
    await actorStore.transact(testDid, async (store) => {
      const record = post(ENGINEERING, 'Original text')
      await store.record.putRecord({
        uri: `at://${testDid}/${COLLECTION}/${RKEY}`,
        cid: await computeCid(record),
        value: record,
        content: encodeRecord(record),
      })
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  it('create op stores its body boundary as the single row and indexes through indexRecordInBoundary', async () => {
    const { indexInBoundary, indexFromBody } = spyOnIndexing()

    await batch({
      action: 'create',
      rkey: 'unit01',
      record: post(ENGINEERING, 'Berserk mode'),
    })

    expect((await storedBoundaries()).unit01).toEqual([ENGINEERING])
    expect(indexInBoundary).toHaveBeenCalledTimes(1)
    expect(indexInBoundary.mock.calls[0][3]).toBe(ENGINEERING)
    expect(indexFromBody).not.toHaveBeenCalled()
  })

  it('update op stores its body boundary as the single row and indexes through indexRecordInBoundary', async () => {
    const { indexInBoundary, indexFromBody } = spyOnIndexing()

    await batch({
      action: 'update',
      rkey: RKEY,
      record: post(ENGINEERING, 'Updated text'),
    })

    expect((await storedBoundaries())[RKEY]).toEqual([ENGINEERING])
    expect(indexInBoundary).toHaveBeenCalledTimes(1)
    expect(indexInBoundary.mock.calls[0][3]).toBe(ENGINEERING)
    expect(indexFromBody).not.toHaveBeenCalled()
  })

  it('moves a record: scoped removal carries the old boundary, exclusion the new, row becomes the new boundary', async () => {
    await batch({
      action: 'update',
      rkey: RKEY,
      record: post(DESIGN, 'Moved text'),
    })

    expect((await storedBoundaries())[RKEY]).toEqual([DESIGN])

    const removals = (await readSeqEvents())
      .map(decodeEvent)
      .filter((decoded) => decoded.ops.some((op) => op.action === 'delete'))
    expect(removals).toHaveLength(1)
    expect(removals[0].boundaries).toEqual([ENGINEERING])
    expect(removals[0].excludeBoundaries).toEqual([DESIGN])
  })

  it('stores each create under its own boundary when one batch mixes boundaries', async () => {
    await batch(
      { action: 'create', rkey: 'rei', record: post(ENGINEERING, 'Rei') },
      { action: 'create', rkey: 'misato', record: post(DESIGN, 'Misato') },
    )

    const stored = await storedBoundaries()
    expect(stored.rei).toEqual([ENGINEERING])
    expect(stored.misato).toEqual([DESIGN])
  })

  it('rejects a create op with a boundary the caller does not hold and writes nothing', async () => {
    ctx.boundaryResolver.getBoundaries.mockResolvedValue([ENGINEERING])
    const before = await storedBoundaries()

    await expect(
      batch(
        {
          action: 'create',
          rkey: 'ritsuko',
          record: post(ENGINEERING, 'Allowed'),
        },
        {
          action: 'create',
          rkey: 'gendo',
          record: post(DESIGN, 'Not held'),
        },
      ),
    ).rejects.toMatchObject({ customErrorName: 'ForbiddenBoundary' })

    expect(await storedBoundaries()).toEqual(before)
  })
})
