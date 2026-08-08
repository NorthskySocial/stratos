/**
 * Move sync contract (adversarial, both channels).
 *
 * A move re-homes a record from an OLD domain to a NEW domain. The observable
 * contract, on BOTH the in-stream `subscribeRecords` gate (`eventInScope`) and
 * the pull endpoint (`listRepoOps`):
 *   - a subscriber scoped ONLY to the old domain observes a REMOVAL,
 *   - a subscriber scoped to the new domain observes a create/update,
 *   - a subscriber scoped to NEITHER observes nothing.
 *
 * These tests drive a REAL update through `updateRecord` (which sequences the
 * move-removal alongside the update) and then replay the raw sequence log
 * through each channel's real gating.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { computeCid, encodeRecord } from '@northskysocial/stratos-core'
import { decode } from '@atcute/cbor'

import { SqliteEnrollmentStore, StratosActorStore } from '../src/context.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db/index.js'
import { applyWritesBatch, updateRecord } from '../src/api/records/index.js'
import {
  decodeEvent,
  eventInScope,
  type SeqEvent,
} from '../src/subscription/index.js'
import { listRepoOps, type RepoOp } from '../src/features/pull-sync/index.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'

const OLD_DOMAIN = 'did:web:nerv.tokyo.jp/engineering'
const NEW_DOMAIN = 'did:web:nerv.tokyo.jp/design'
const THIRD_DOMAIN = 'did:web:nerv.tokyo.jp/general'

describe('Record move sync contract', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let enrollmentStore: SqliteEnrollmentStore
  let db: ServiceDb
  let ctx: any

  const testDid = 'did:plc:shinji-ikari'
  const serviceDid = 'did:web:nerv.tokyo.jp'
  const collection = 'zone.stratos.feed.post'
  const rkey = 'post1'

  function post(domain: string, text: string) {
    return {
      $type: collection,
      text,
      createdAt: new Date().toISOString(),
      boundary: {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: [{ value: domain }],
      },
    }
  }

  /** Read every sequence event for the actor as decodable SeqEvents. */
  async function readAllSeqEvents(): Promise<SeqEvent[]> {
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

  /** Ops a subscribeRecords caller holding `boundaries` would observe. */
  async function inStreamOpsFor(
    boundaries: string[],
  ): Promise<Array<{ action: string; path: string }>> {
    const caller = new Set(boundaries)
    const events = await readAllSeqEvents()
    const observed: Array<{ action: string; path: string }> = []
    for (const event of events) {
      const decoded = decodeEvent(event)
      if (!eventInScope(decoded, caller)) continue
      for (const op of decoded.ops) {
        observed.push({ action: op.action, path: op.path })
      }
    }
    return observed
  }

  /** Ops a listRepoOps (pull) caller holding `boundaries` would observe. */
  async function pullOpsFor(boundaries: string[]): Promise<RepoOp[]> {
    const res = await listRepoOps(
      ctx,
      { did: testDid, limit: 1000, excludeValues: false },
      new Set(boundaries),
    )
    return res.ops
  }

  beforeEach(async () => {
    dataDir = join(tmpdir(), `stratos-test-${randomBytes(8).toString('hex')}`)
    await mkdir(dataDir, { recursive: true })

    const cfg = createTestConfig(dataDir)
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)

    enrollmentStore = new SqliteEnrollmentStore(db)
    actorStore = new StratosActorStore({
      dataDir,
      blobstore: () => createMockBlobStore() as any,
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })

    ctx = {
      cfg,
      actorStore,
      enrollmentStore,
      serviceDid,
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
        getBoundaries: vi
          .fn()
          .mockResolvedValue([OLD_DOMAIN, NEW_DOMAIN, THIRD_DOMAIN]),
      },
    }

    // Seed a record homed in OLD_DOMAIN.
    await actorStore.create(testDid)
    await actorStore.transact(testDid, async (store) => {
      const record = post(OLD_DOMAIN, 'Original text')
      const cid = await computeCid(record)
      await store.record.putRecord({
        uri: `at://${testDid}/${collection}/${rkey}`,
        cid,
        value: record,
        content: encodeRecord(record),
      })
    })
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  /** Perform the move: re-home the record from OLD_DOMAIN to NEW_DOMAIN. */
  async function performMove() {
    await (updateRecord as any)(
      ctx,
      { repo: testDid, collection, rkey, record: post(NEW_DOMAIN, 'Moved') },
      testDid,
    )
  }

  it('in-stream: old-domain-only observer sees a removal', async () => {
    await performMove()
    const observed = await inStreamOpsFor([OLD_DOMAIN])
    expect(observed).toContainEqual({
      action: 'delete',
      path: `${collection}/${rkey}`,
    })
    // It must NOT observe the create/update into the new domain.
    expect(observed).not.toContainEqual({
      action: 'update',
      path: `${collection}/${rkey}`,
    })
  })

  it('in-stream: new-domain observer sees the update, not a removal', async () => {
    await performMove()
    const observed = await inStreamOpsFor([NEW_DOMAIN])
    expect(observed).toContainEqual({
      action: 'update',
      path: `${collection}/${rkey}`,
    })
    expect(observed).not.toContainEqual({
      action: 'delete',
      path: `${collection}/${rkey}`,
    })
  })

  it('in-stream: third-party observer sees nothing', async () => {
    await performMove()
    const observed = await inStreamOpsFor([THIRD_DOMAIN])
    expect(observed).toHaveLength(0)
  })

  it('pull: old-domain-only observer sees a removal (cid absent)', async () => {
    await performMove()
    const ops = await pullOpsFor([OLD_DOMAIN])
    const forRecord = ops.filter((o) => o.rkey === rkey)
    expect(forRecord).toHaveLength(1)
    expect(forRecord[0]).toMatchObject({ rkey })
    expect(forRecord[0].cid).toBeUndefined()
  })

  it('pull: new-domain observer sees the record present (cid present)', async () => {
    await performMove()
    const ops = await pullOpsFor([NEW_DOMAIN])
    const forRecord = ops.filter((o) => o.rkey === rkey)
    expect(forRecord).toHaveLength(1)
    expect(forRecord[0].cid).toBeDefined()
  })

  it('pull: third-party observer sees nothing', async () => {
    await performMove()
    const ops = await pullOpsFor([THIRD_DOMAIN])
    expect(ops.filter((o) => o.rkey === rkey)).toHaveLength(0)
  })

  it('a non-move update (same domain) emits no removal for the same-domain observer', async () => {
    await (updateRecord as any)(
      ctx,
      {
        repo: testDid,
        collection,
        rkey,
        record: post(OLD_DOMAIN, 'edited in place'),
      },
      testDid,
    )
    const observed = await inStreamOpsFor([OLD_DOMAIN])
    // Only the update op, never a delete — nothing was re-homed.
    expect(observed.filter((o) => o.action === 'delete')).toHaveLength(0)
    expect(observed).toContainEqual({
      action: 'update',
      path: `${collection}/${rkey}`,
    })
  })

  it('batch move: old-domain-only sees removal, new-domain sees update, third-party nothing', async () => {
    await applyWritesBatch(ctx, testDid, [
      { action: 'update', collection, rkey, record: post(NEW_DOMAIN, 'Moved') },
    ])

    // In-stream channel.
    const oldObs = await inStreamOpsFor([OLD_DOMAIN])
    expect(oldObs).toContainEqual({
      action: 'delete',
      path: `${collection}/${rkey}`,
    })
    const newObs = await inStreamOpsFor([NEW_DOMAIN])
    expect(newObs).toContainEqual({
      action: 'update',
      path: `${collection}/${rkey}`,
    })
    expect(newObs).not.toContainEqual({
      action: 'delete',
      path: `${collection}/${rkey}`,
    })
    expect(await inStreamOpsFor([THIRD_DOMAIN])).toHaveLength(0)

    // Pull channel.
    const oldPull = (await pullOpsFor([OLD_DOMAIN])).filter(
      (o) => o.rkey === rkey,
    )
    expect(oldPull).toHaveLength(1)
    expect(oldPull[0].cid).toBeUndefined()
    const newPull = (await pullOpsFor([NEW_DOMAIN])).filter(
      (o) => o.rkey === rkey,
    )
    expect(newPull).toHaveLength(1)
    expect(newPull[0].cid).toBeDefined()
    expect(
      (await pullOpsFor([THIRD_DOMAIN])).filter((o) => o.rkey === rkey),
    ).toHaveLength(0)
  })

  it('batch: emit fires only after the commit is durable', async () => {
    // Wrap the real transact() so we know — synchronously, at the instant
    // emit fires — whether the write transaction has actually resolved.
    // Firing emit before this flag flips true is exactly the bug: subscribers
    // would wake and find nothing new yet.
    const originalTransact = actorStore.transact.bind(actorStore)
    let transactionDurable = false
    ;(
      actorStore as unknown as { transact: typeof actorStore.transact }
    ).transact = (async (...args: Parameters<typeof actorStore.transact>) => {
      const outcome = await (originalTransact as any)(...args)
      transactionDurable = true
      return outcome
    }) as typeof actorStore.transact

    let durableAtEmitTime = false
    let seqReadStartedAtEmitTime: Promise<SeqEvent[]> | undefined
    ctx.sequenceEvents.emit = vi.fn(() => {
      durableAtEmitTime = transactionDurable
      // Kick off the log read from inside the listener itself — the same
      // thing a real subscribeRecords consumer does on wake — and capture
      // the promise synchronously so we can inspect what it saw.
      seqReadStartedAtEmitTime = readAllSeqEvents()
    })

    const batchRkey = 'asuka-langley-post'
    await applyWritesBatch(ctx, testDid, [
      {
        action: 'create',
        collection,
        rkey: batchRkey,
        record: post(NEW_DOMAIN, 'Batch durability check'),
      },
    ])

    expect(ctx.sequenceEvents.emit).toHaveBeenCalledTimes(1)
    expect(durableAtEmitTime).toBe(true)

    const seqEventsAtEmitTime = await seqReadStartedAtEmitTime!
    const observedForBatchRecord = seqEventsAtEmitTime.some((event) => {
      const decoded = decodeEvent(event)
      return decoded.ops.some((op) => op.path === `${collection}/${batchRkey}`)
    })
    expect(observedForBatchRecord).toBe(true)
  })

  it('batch: a rejected commit emits nothing', async () => {
    const keyVaultError = new Error('key vault offline')
    ctx.actorSigner.getSignFn = vi.fn().mockRejectedValue(keyVaultError)

    await expect(
      applyWritesBatch(ctx, testDid, [
        {
          action: 'create',
          collection,
          rkey: 'misato-katsuragi-post',
          record: post(NEW_DOMAIN, 'Should never land'),
        },
      ]),
    ).rejects.toThrow('key vault offline')

    expect(ctx.sequenceEvents.emit).not.toHaveBeenCalled()
  })
})
