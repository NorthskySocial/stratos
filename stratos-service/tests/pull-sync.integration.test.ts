import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { encodeRecord } from '@northskysocial/stratos-core'
import { decode } from '@atcute/cbor'

import { SqliteEnrollmentStore, StratosActorStore } from '../src/context.js'
import type { AppContext } from '../src/context.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db/index.js'
import { SqliteLabelStore } from '../src/features/moderation/index.js'
import {
  decodeSeqCursor,
  encodeSeqCursor,
  listRecordPaths,
  listRepoOps,
  OplogTruncatedError,
  readCurrentSignedCommit,
} from '../src/features/pull-sync/index.js'
import { SEQUENCE_DB_PAGE_SIZE } from '../src/subscription/sequence-paging.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'

// ── TIDs (lexicographically ascending) ──────────────────────────────────────
const REV = {
  r1: '3aaaa000000t1',
  r2: '3bbbb000000t2',
  r3: '3cccc000000t3',
  r4: '3dddd000000t4',
  ancient: '3000000000t00',
}

interface OpSpec {
  action: 'create' | 'update' | 'delete'
  path: string
  cid?: string
  boundary?: string
  text?: string
}

describe('Pull-sync (listRepoOps / listRecordPaths)', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let enrollmentStore: SqliteEnrollmentStore
  let db: ServiceDb
  let ctx: AppContext

  const repoDid = 'did:plc:shinji-ikari'
  const serviceDid = 'did:web:nerv.tokyo.jp'
  const otherServiceDid = 'did:web:seele.de'

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

    ctx = {
      cfg,
      actorStore,
      enrollmentStore,
      serviceDid,
      labelStore: new SqliteLabelStore(db, join(dataDir, 'service.sqlite')),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
    } as unknown as AppContext
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  // ── helpers ────────────────────────────────────────────────────────────────

  async function enrollService(did: string, boundaries: string[]) {
    await enrollmentStore.enroll({
      did,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: did,
      isService: true,
    })
    await enrollmentStore.setBoundaries(did, boundaries)
  }

  /** Append an event (single commit, possibly multi-op) sharing one rev. */
  async function appendEvent(did: string, rev: string, ops: OpSpec[]) {
    const eventData = encodeRecord({
      rev,
      ops: ops.map((op) => {
        const base: Record<string, unknown> = {
          action: op.action,
          path: op.path,
        }
        if (op.action !== 'delete') {
          base.cid = op.cid
          base.record = {
            text: op.text ?? 'hello',
            boundary: { values: [{ value: op.boundary ?? 'nerv' }] },
          }
        }
        return base
      }),
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

  function callerSet(...b: string[]): ReadonlySet<string> {
    return new Set(b)
  }

  // ── cursor codec ─────────────────────────────────────────────────────────

  describe('cursor codec', () => {
    it('round-trips a seq', () => {
      expect(decodeSeqCursor(encodeSeqCursor(42))).toBe(42)
      expect(decodeSeqCursor(encodeSeqCursor(0))).toBe(0)
    })
    it('rejects malformed cursors', () => {
      expect(decodeSeqCursor('not-a-cursor')).toBeNull()
      expect(
        decodeSeqCursor(Buffer.from('x:5').toString('base64url')),
      ).toBeNull()
    })
  })

  // ── op shapes & ordering ─────────────────────────────────────────────────

  describe('listRepoOps op shapes', () => {
    it('emits create/update/delete with correct cid/prev presence, in order', async () => {
      await actorStore.create(repoDid)
      await appendEvent(repoDid, REV.r1, [
        { action: 'create', path: 'zone.stratos.feed.post/a', cid: 'cidA1' },
      ])
      await appendEvent(repoDid, REV.r2, [
        { action: 'update', path: 'zone.stratos.feed.post/b', cid: 'cidB1' },
      ])
      // A delete op carries no record ⇒ no boundary in the blob. To be delivered
      // (not fail-closed dropped), it must share its event with an in-scope op
      // whose boundary the caller holds — the same union semantics as
      // subscribeRecords. Here the batch's create carries the `nerv` boundary.
      await appendEvent(repoDid, REV.r3, [
        {
          action: 'create',
          path: 'zone.stratos.feed.post/keep',
          cid: 'cidKeep',
        },
        { action: 'delete', path: 'zone.stratos.feed.post/c' },
      ])

      const res = await listRepoOps(
        ctx,
        { did: repoDid, limit: 100, excludeValues: false },
        callerSet('nerv'),
      )

      expect(res.cursor).toBeUndefined()
      expect(res.ops.map((o) => o.rev)).toEqual([
        REV.r1,
        REV.r2,
        REV.r3,
        REV.r3,
      ])
      // create: cid present, prev null (nullable lexicon field; null = create)
      expect(res.ops[0]).toMatchObject({
        collection: 'zone.stratos.feed.post',
        rkey: 'a',
        cid: 'cidA1',
      })
      expect(res.ops[0].prev).toBeNull()
      // update: cid present (prev null here since prior value not in-window)
      expect(res.ops[1]).toMatchObject({ rkey: 'b', cid: 'cidB1', prev: null })
      // delete: cid null
      const del = res.ops.find((o) => o.rkey === 'c')!
      expect(del).toMatchObject({ rkey: 'c', rev: REV.r3 })
      expect(del.cid).toBeNull()
    })

    it('fail-closed: a delete-only event (no boundary in blob) is dropped', async () => {
      await actorStore.create(repoDid)
      await appendEvent(repoDid, REV.r1, [
        { action: 'delete', path: 'zone.stratos.feed.post/gone' },
      ])
      const res = await listRepoOps(
        ctx,
        { did: repoDid, limit: 100, excludeValues: false },
        callerSet('nerv'),
      )
      // No resolvable boundary ⇒ dropped (matches subscribeRecords gate). This
      // prevents an existence leak; in-scope deletes ride along a batch that
      // carries a boundary (see prior test).
      expect(res.ops).toHaveLength(0)
    })

    it('expands an atomic multi-write batch into per-op entries sharing one rev', async () => {
      await actorStore.create(repoDid)
      await appendEvent(repoDid, REV.r1, [
        { action: 'create', path: 'zone.stratos.feed.post/x', cid: 'cidX' },
        { action: 'create', path: 'zone.stratos.feed.post/y', cid: 'cidY' },
        { action: 'delete', path: 'zone.stratos.feed.post/z' },
      ])

      const res = await listRepoOps(
        ctx,
        { did: repoDid, limit: 100, excludeValues: false },
        callerSet('nerv'),
      )
      expect(res.ops).toHaveLength(3)
      expect(res.ops.every((o) => o.rev === REV.r1)).toBe(true)
      expect(res.ops.map((o) => o.rkey)).toEqual(['x', 'y', 'z'])
    })

    it('inlines values by default and omits them with excludeValues', async () => {
      await actorStore.create(repoDid)
      await appendEvent(repoDid, REV.r1, [
        {
          action: 'create',
          path: 'zone.stratos.feed.post/a',
          cid: 'cidA',
          text: 'inline me',
        },
      ])

      const inlined = await listRepoOps(
        ctx,
        { did: repoDid, limit: 100, excludeValues: false },
        callerSet('nerv'),
      )
      expect((inlined.ops[0].value as any).text).toBe('inline me')

      const meta = await listRepoOps(
        ctx,
        { did: repoDid, limit: 100, excludeValues: true },
        callerSet('nerv'),
      )
      expect(meta.ops[0].value).toBeUndefined()
      expect(meta.ops[0].cid).toBe('cidA')
    })

    it('coalesces to current-value-only when a path is rewritten in-window', async () => {
      await actorStore.create(repoDid)
      await appendEvent(repoDid, REV.r1, [
        {
          action: 'create',
          path: 'zone.stratos.feed.post/a',
          cid: 'cidA1',
          text: 'stale',
        },
      ])
      await appendEvent(repoDid, REV.r2, [
        {
          action: 'update',
          path: 'zone.stratos.feed.post/a',
          cid: 'cidA2',
          text: 'current',
        },
      ])

      const res = await listRepoOps(
        ctx,
        { did: repoDid, limit: 100, excludeValues: false },
        callerSet('nerv'),
      )
      // Only the current value survives for path a.
      const forA = res.ops.filter((o) => o.rkey === 'a')
      expect(forA).toHaveLength(1)
      expect(forA[0].cid).toBe('cidA2')
      expect((forA[0].value as any).text).toBe('current')
      // prev reflects the superseded CID seen in-window.
      expect(forA[0].prev).toBe('cidA1')
    })
  })

  // ── since / OplogTruncated ───────────────────────────────────────────────

  describe('since start-mapping and OplogTruncated', () => {
    it('returns only ops after `since`', async () => {
      await actorStore.create(repoDid)
      await appendEvent(repoDid, REV.r1, [
        { action: 'create', path: 'zone.stratos.feed.post/a', cid: 'c1' },
      ])
      await appendEvent(repoDid, REV.r2, [
        { action: 'create', path: 'zone.stratos.feed.post/b', cid: 'c2' },
      ])
      await appendEvent(repoDid, REV.r3, [
        { action: 'create', path: 'zone.stratos.feed.post/c', cid: 'c3' },
      ])

      const res = await listRepoOps(
        ctx,
        { did: repoDid, since: REV.r1, limit: 100, excludeValues: false },
        callerSet('nerv'),
      )
      expect(res.ops.map((o) => o.rev)).toEqual([REV.r2, REV.r3])
      expect(res.cursor).toBeUndefined()
    })

    it('throws OplogTruncated when `since` predates retained history', async () => {
      await actorStore.create(repoDid)
      await appendEvent(repoDid, REV.r2, [
        { action: 'create', path: 'zone.stratos.feed.post/a', cid: 'c1' },
      ])
      await appendEvent(repoDid, REV.r3, [
        { action: 'create', path: 'zone.stratos.feed.post/b', cid: 'c2' },
      ])

      await expect(
        listRepoOps(
          ctx,
          {
            did: repoDid,
            since: REV.ancient,
            limit: 100,
            excludeValues: false,
          },
          callerSet('nerv'),
        ),
      ).rejects.toBeInstanceOf(OplogTruncatedError)
    })

    it('throws OplogTruncated when `since` postdates the newest retained rev', async () => {
      // A `since` newer than anything this repo issued (foreign/garbage rev)
      // must not silently return a head response - the syncer would diverge
      // with no path back to recovery.
      await actorStore.create(repoDid)
      await appendEvent(repoDid, REV.r1, [
        { action: 'create', path: 'zone.stratos.feed.post/a', cid: 'c1' },
      ])

      await expect(
        listRepoOps(
          ctx,
          { did: repoDid, since: REV.r4, limit: 100, excludeValues: false },
          callerSet('nerv'),
        ),
      ).rejects.toBeInstanceOf(OplogTruncatedError)
    })

    it('accepts `since` equal to the newest rev (routine caught-up poll)', async () => {
      await actorStore.create(repoDid)
      await appendEvent(repoDid, REV.r1, [
        { action: 'create', path: 'zone.stratos.feed.post/a', cid: 'c1' },
      ])

      const res = await listRepoOps(
        ctx,
        { did: repoDid, since: REV.r1, limit: 100, excludeValues: false },
        callerSet('nerv'),
      )
      expect(res.ops).toEqual([])
      expect(res.cursor).toBeUndefined()
    })

    it('throws OplogTruncated for `since` against an empty log (unverifiable)', async () => {
      // With no retained history at all the claimed position cannot be
      // verified; fail closed into full-state recovery.
      await actorStore.create(repoDid)

      await expect(
        listRepoOps(
          ctx,
          { did: repoDid, since: REV.r1, limit: 100, excludeValues: false },
          callerSet('nerv'),
        ),
      ).rejects.toBeInstanceOf(OplogTruncatedError)
    })

    it('throws OplogTruncated when compaction advanced past a page cursor', async () => {
      // Simulate a log whose retained history starts at seq 10 (everything
      // earlier compacted away) while the caller resumes from a cursor issued
      // before the compaction. Silently resuming would skip the trimmed ops
      // and report a false head.
      await actorStore.create(repoDid)
      const rows = [10, 11, 12].map((seq, i) => ({
        seq,
        did: repoDid,
        eventType: 'append',
        event: Buffer.from(
          encodeRecord({
            rev: `3zzzz00000${i}t1`,
            ops: [
              {
                action: 'create',
                path: `zone.stratos.feed.post/r${seq}`,
                cid: `cid${seq}`,
                record: {
                  text: 'hello',
                  boundary: { values: [{ value: 'nerv' }] },
                },
              },
            ],
          }),
        ),
        invalidated: 0,
        sequencedAt: new Date().toISOString(),
      }))
      const compactedCtx = {
        ...ctx,
        actorStore: {
          exists: async () => true,
          read: async (did: string, fn: (store: unknown) => unknown) =>
            actorStore.read(did, (store: any) =>
              fn({
                sequence: {
                  getOldestSeq: async () => 10,
                  getLatestSeq: async () => 12,
                  getEventsSince: async (after: number, limit = 100) =>
                    rows.filter((r) => r.seq > after).slice(0, limit),
                },
                record: store.record,
                // No commits yet - the head path tolerates a missing root.
                repo: { getRootDetailed: async () => null },
              }),
            ),
        },
      } as unknown as AppContext

      await expect(
        listRepoOps(
          compactedCtx,
          {
            did: repoDid,
            cursor: encodeSeqCursor(3),
            limit: 100,
            excludeValues: false,
          },
          callerSet('nerv'),
        ),
      ).rejects.toBeInstanceOf(OplogTruncatedError)

      // A cursor at the compaction edge (next owed = oldest retained) is
      // still a valid resume point.
      const ok = await listRepoOps(
        compactedCtx,
        {
          did: repoDid,
          cursor: encodeSeqCursor(9),
          limit: 100,
          excludeValues: false,
        },
        callerSet('nerv'),
      )
      expect(ok.ops).toHaveLength(3)
    })

    it('throws OplogTruncated when the cursor is beyond retained history', async () => {
      // A cursor past the newest retained event names a seq this log never
      // issued (for example after a log reset). Silently resuming would
      // report a false caught-up.
      await actorStore.create(repoDid)
      await appendEvent(repoDid, REV.r1, [
        { action: 'create', path: 'zone.stratos.feed.post/a', cid: 'cidA1' },
      ])

      const promise = listRepoOps(
        ctx,
        {
          did: repoDid,
          cursor: encodeSeqCursor(5),
          limit: 100,
          excludeValues: false,
        },
        callerSet('nerv'),
      )
      await expect(promise).rejects.toBeInstanceOf(OplogTruncatedError)
      await expect(promise).rejects.toThrow('cursor is beyond retained history')
    })
  })

  // ── adversarial boundary gating ──────────────────────────────────────────

  describe('adversarial boundary gating', () => {
    it('listRepoOps: caller in A cannot observe records only in B (incl. deletes)', async () => {
      await actorStore.create(repoDid)
      // A-scoped create, B-scoped create, B-scoped delete.
      await appendEvent(repoDid, REV.r1, [
        {
          action: 'create',
          path: 'zone.stratos.feed.post/a',
          cid: 'cidA',
          boundary: 'alpha',
        },
      ])
      await appendEvent(repoDid, REV.r2, [
        {
          action: 'create',
          path: 'zone.stratos.feed.post/b',
          cid: 'cidB',
          boundary: 'beta',
        },
      ])
      // A beta-scoped batch: a beta create + a beta delete. The event's boundary
      // union is {beta}, so an alpha caller must observe NEITHER op — including
      // the delete (existence leak prevention).
      await appendEvent(repoDid, REV.r3, [
        {
          action: 'create',
          path: 'zone.stratos.feed.post/b2',
          cid: 'cidB2',
          boundary: 'beta',
        },
        { action: 'delete', path: 'zone.stratos.feed.post/b' },
      ])

      const res = await listRepoOps(
        ctx,
        { did: repoDid, limit: 100, excludeValues: false },
        callerSet('alpha'),
      )
      // Only the alpha op is visible; the beta create, the beta batch, and its
      // delete are all hidden.
      expect(res.ops.map((o) => o.rkey)).toEqual(['a'])
      expect(res.ops.some((o) => o.rkey === 'b')).toBe(false)
      expect(res.ops.some((o) => o.rkey === 'b2')).toBe(false)
    })

    it('listRecordPaths: caller in A cannot enumerate records only in B', async () => {
      await actorStore.create(repoDid)
      await seedRecord(repoDid, 'zone.stratos.feed.post', 'a', 'alpha')
      await seedRecord(repoDid, 'zone.stratos.feed.post', 'b', 'beta')

      const res = await listRecordPaths(
        ctx,
        { did: repoDid, limit: 100, excludeValues: false },
        callerSet('alpha'),
      )
      expect(res.records.map((r) => r.rkey)).toEqual(['a'])
    })

    it('fails closed for a caller with no shared boundary at all', async () => {
      await actorStore.create(repoDid)
      await appendEvent(repoDid, REV.r1, [
        {
          action: 'create',
          path: 'zone.stratos.feed.post/a',
          cid: 'cidA',
          boundary: 'alpha',
        },
      ])
      const res = await listRepoOps(
        ctx,
        { did: repoDid, limit: 100, excludeValues: false },
        callerSet('gamma'),
      )
      expect(res.ops).toHaveLength(0)
      expect(res.cursor).toBeUndefined()
    })

    it('fails closed on an undecodable event (no existence leak)', async () => {
      await actorStore.create(repoDid)
      await actorStore.transact(repoDid, async (store: any) => {
        await store.sequence.appendEvent({
          did: repoDid,
          eventType: 'append',
          event: new Uint8Array([0xff, 0xfe, 0xfd]),
          invalidated: 0,
          sequencedAt: new Date().toISOString(),
        })
      })
      const res = await listRepoOps(
        ctx,
        { did: repoDid, limit: 100, excludeValues: false },
        callerSet('nerv'),
      )
      expect(res.ops).toHaveLength(0)
    })
  })

  // ── pagination stability ─────────────────────────────────────────────────

  describe('pagination stability', () => {
    it('never skips or duplicates ops across pages, even with concurrent appends', async () => {
      await actorStore.create(repoDid)
      // Seed 5 events.
      for (let i = 0; i < 5; i++) {
        await appendEvent(repoDid, `3aaaa00000${i}t1`, [
          {
            action: 'create',
            path: `zone.stratos.feed.post/p${i}`,
            cid: `cid${i}`,
          },
        ])
      }

      const seen: string[] = []
      let cursor: string | undefined
      let atHead = false
      let guard = 0
      while (!atHead && guard++ < 20) {
        const res = await listRepoOps(
          ctx,
          { did: repoDid, limit: 2, cursor, excludeValues: false },
          callerSet('nerv'),
        )
        for (const op of res.ops) seen.push(op.rkey)
        // Append a NEW event mid-pagination to prove stability.
        if (guard === 1) {
          await appendEvent(repoDid, '3aaaa00000zt1', [
            {
              action: 'create',
              path: 'zone.stratos.feed.post/late',
              cid: 'cidLate',
            },
          ])
        }
        cursor = res.cursor
        // Head of the oplog = cursor absent.
        atHead = res.cursor === undefined
      }

      // Every seeded op appears exactly once; the late one appears too, once.
      const counts = seen.reduce<Record<string, number>>((m, k) => {
        m[k] = (m[k] ?? 0) + 1
        return m
      }, {})
      for (const k of ['p0', 'p1', 'p2', 'p3', 'p4', 'late']) {
        expect(counts[k]).toBe(1)
      }
      expect(atHead).toBe(true)
    })
  })

  // ── takedown filter ──────────────────────────────────────────────────────

  describe('takedown filter', () => {
    const POST = 'zone.stratos.feed.post'
    const uriOf = (rkey: string) => `at://${repoDid}/${POST}/${rkey}`

    async function indexPost(rkey: string) {
      const { computeCid, parseCid } =
        await import('@northskysocial/stratos-core')
      const record = {
        text: rkey,
        boundary: { values: [{ value: 'nerv' }] },
      }
      const cid = parseCid((await computeCid(record)).toString())
      await actorStore.transact(repoDid, async (store: any) => {
        await store.record.indexRecord(uriOf(rkey), cid, record, 'create', 'r1')
      })
    }

    async function setTakedown(rkey: string, applied: boolean) {
      await actorStore.transact(repoDid, async (store: any) => {
        await store.record.updateRecordTakedown(
          uriOf(rkey),
          applied ? { applied, ref: `TD-${rkey}` } : { applied },
        )
      })
    }

    async function commitPosts(rkeys: string[]) {
      const { P256Keypair } = await import('@atproto/crypto')
      const { buildCommit, computeCid, parseCid } =
        await import('@northskysocial/stratos-core')
      const { StratosBlockStoreReader, signAndPersistCommit } =
        await import('../src/features/index.js')
      const keypair = await P256Keypair.create({ exportable: true })
      await actorStore.transact(repoDid, async (store: any) => {
        const record = { text: 'commit', boundary: { values: [] } }
        const recordCid = await computeCid(record)
        const unsigned = await buildCommit(
          new StratosBlockStoreReader(store.repo),
          null,
          {
            did: repoDid,
            writes: rkeys.map((rkey) => ({
              action: 'create' as const,
              collection: POST,
              rkey,
              cid: parseCid(recordCid).toString(),
            })),
          },
        )
        await store.repo.putBlock(recordCid, encodeRecord(record), unsigned.rev)
        await signAndPersistCommit(
          store.repo,
          (bytes: Uint8Array) => keypair.sign(bytes),
          unsigned,
        )
      })
    }

    const list = (
      excludeValues: boolean,
      extra: { limit?: number; cursor?: string } = {},
    ) =>
      listRepoOps(
        ctx,
        { did: repoDid, limit: extra.limit ?? 100, excludeValues, ...extra },
        callerSet('nerv'),
      )

    it('omits a taken-down record and keeps the head commit unchanged (o1)', async () => {
      await actorStore.create(repoDid)
      await commitPosts(['ayanami', 'soryu'])
      await appendEvent(repoDid, REV.r1, [
        { action: 'create', path: `${POST}/ayanami`, cid: 'cidA' },
      ])
      await appendEvent(repoDid, REV.r2, [
        { action: 'create', path: `${POST}/soryu`, cid: 'cidB' },
      ])
      await indexPost('ayanami')
      await indexPost('soryu')
      const commitBefore = await readCurrentSignedCommit(ctx, repoDid)

      await setTakedown('ayanami', true)

      for (const excludeValues of [false, true]) {
        const res = await list(excludeValues)
        expect(res.ops.map((op) => op.rkey)).toEqual(['soryu'])
        expect(res.ops[0].cid).toBe('cidB')
        expect(res.ops[0].value === undefined).toBe(excludeValues)
        expect(res.cursor).toBeUndefined()
        expect(commitBefore).not.toBeNull()
        expect(res.commit).toEqual(commitBefore)
      }
    })

    it('still returns the other op of a batch event (o2)', async () => {
      await actorStore.create(repoDid)
      await appendEvent(repoDid, REV.r1, [
        { action: 'create', path: `${POST}/ayanami`, cid: 'cidA' },
        { action: 'create', path: `${POST}/soryu`, cid: 'cidB' },
      ])
      await indexPost('ayanami')
      await indexPost('soryu')
      await setTakedown('ayanami', true)

      const res = await list(false)

      expect(res.ops.map((op) => [op.rev, op.rkey, op.cid])).toEqual([
        [REV.r1, 'soryu', 'cidB'],
      ])
    })

    it('skips an emptied event without counting it and pages on (o3)', async () => {
      await actorStore.create(repoDid)
      for (const [i, rkey] of [
        'ayanami',
        'soryu',
        'katsuragi',
        'ikari',
      ].entries()) {
        await appendEvent(repoDid, `3aaaa00000${i}t1`, [
          { action: 'create', path: `${POST}/${rkey}`, cid: `cid-${rkey}` },
        ])
        await indexPost(rkey)
      }
      await setTakedown('ayanami', true)
      await setTakedown('katsuragi', true)

      const first = await list(false, { limit: 1 })
      expect(first.ops.map((op) => op.rkey)).toEqual(['soryu'])
      expect(first.cursor).toBe(encodeSeqCursor(2))

      const second = await list(false, { limit: 1, cursor: first.cursor })
      expect(second.ops.map((op) => op.rkey)).toEqual(['ikari'])
      expect(second.cursor).toBe(encodeSeqCursor(4))

      const third = await list(false, { limit: 1, cursor: second.cursor })
      expect(third.ops).toEqual([])
      expect(third.cursor).toBeUndefined()
    })

    it('serves the record again after a negation (o4)', async () => {
      await actorStore.create(repoDid)
      await appendEvent(repoDid, REV.r1, [
        { action: 'create', path: `${POST}/ayanami`, cid: 'cidA' },
      ])
      await indexPost('ayanami')

      await setTakedown('ayanami', true)
      expect((await list(false)).ops).toEqual([])

      await setTakedown('ayanami', false)
      const res = await list(false)
      expect(res.ops.map((op) => op.rkey)).toEqual(['ayanami'])
      expect((res.ops[0].value as { text: string }).text).toBe('hello')
    })

    it('passes a delete of a taken-down record through (o5)', async () => {
      await actorStore.create(repoDid)
      await indexPost('ayanami')
      await setTakedown('ayanami', true)
      await appendEvent(repoDid, REV.r1, [
        { action: 'create', path: `${POST}/soryu`, cid: 'cidB' },
        { action: 'delete', path: `${POST}/ayanami` },
      ])

      const res = await list(false)

      expect(res.ops.map((op) => [op.rkey, op.cid])).toEqual([
        ['soryu', 'cidB'],
        ['ayanami', null],
      ])
    })

    it('looks up takedowns once per page with in-scope writes (o6)', async () => {
      await actorStore.create(repoDid)
      const pageSize = SEQUENCE_DB_PAGE_SIZE
      // Page 1 and 3 hold in-scope creates; page 2 holds only creates in a
      // boundary the caller lacks, so it has nothing to look up.
      const total = pageSize * 2 + 30
      await actorStore.transact(repoDid, async (store: any) => {
        for (let i = 0; i < total; i++) {
          const inScopePage = i < pageSize || i >= pageSize * 2
          await store.sequence.appendEvent({
            did: repoDid,
            eventType: 'append',
            event: encodeRecord({
              rev: `3aaaa${String(i).padStart(6, '0')}t1`,
              ops: [
                {
                  action: 'create',
                  path: `${POST}/p${i}`,
                  cid: `cid${i}`,
                  record: {
                    text: 'hello',
                    boundary: {
                      values: [{ value: inScopePage ? 'nerv' : 'seele' }],
                    },
                  },
                },
              ],
            }),
            invalidated: 0,
            sequencedAt: new Date().toISOString(),
          })
        }
      })
      const lookups: string[][] = []
      const countingCtx = {
        ...ctx,
        actorStore: {
          exists: (did: string) => actorStore.exists(did),
          read: (did: string, fn: (store: unknown) => unknown) =>
            actorStore.read(did, (store: any) =>
              fn({
                ...store,
                sequence: store.sequence,
                repo: store.repo,
                record: {
                  getTakedownStates: (uris: string[]) => {
                    lookups.push(uris)
                    return store.record.getTakedownStates(uris)
                  },
                },
              }),
            ),
        },
      } as unknown as AppContext

      const res = await listRepoOps(
        countingCtx,
        { did: repoDid, limit: 1000, excludeValues: true },
        callerSet('nerv'),
      )

      expect(res.ops).toHaveLength(pageSize + 30)
      expect(lookups.map((uris) => uris.length)).toEqual([pageSize, 30])
    })
    it('(r6a) delivers the delete of a record whose recreated value is taken down', async () => {
      await actorStore.create(repoDid)
      const appendRaw = async (
        rev: string,
        ops: Array<Record<string, unknown>>,
      ) =>
        actorStore.transact(repoDid, async (store: any) => {
          await store.sequence.appendEvent({
            did: repoDid,
            eventType: 'append',
            event: encodeRecord({ rev, ops }),
            invalidated: 0,
            sequencedAt: new Date().toISOString(),
          })
        })
      const body = { text: 'hello', boundary: { values: [{ value: 'nerv' }] } }
      const path = `${POST}/ayanami`
      await appendRaw(REV.r1, [
        { action: 'create', path, cid: 'cidOld', record: body },
      ])
      await appendRaw(REV.r2, [
        { action: 'delete', path, boundary: { values: [{ value: 'nerv' }] } },
      ])
      await appendRaw(REV.r3, [
        { action: 'create', path, cid: 'cidNew', record: body },
      ])
      await indexPost('ayanami')
      await setTakedown('ayanami', true)

      const first = await list(false, { limit: 1 })
      expect(first.ops.map((op) => [op.rev, op.rkey, op.cid])).toEqual([
        [REV.r2, 'ayanami', null],
      ])
      expect(first.cursor).toBe(encodeSeqCursor(2))

      const second = await list(false, { limit: 1, cursor: first.cursor })
      expect(second.ops).toEqual([])
    })

    describe('(e7) a page costs at most one record-state query and one label query', () => {
      function budgetCtx() {
        const calls = { states: 0, labels: [] as string[][] }
        const budgetCtx = {
          ...ctx,
          actorStore: {
            exists: (did: string) => actorStore.exists(did),
            read: (did: string, fn: (store: unknown) => unknown) =>
              actorStore.read(did, (store: any) =>
                fn({
                  ...store,
                  record: {
                    getTakedownStates: (uris: string[]) => {
                      calls.states++
                      return store.record.getTakedownStates(uris)
                    },
                  },
                }),
              ),
          },
          labelStore: {
            latestTakedowns: (keys: string[]) => {
              calls.labels.push([...keys].sort())
              return ctx.labelStore.latestTakedowns(keys)
            },
          },
        } as unknown as AppContext
        return { calls, ctx: budgetCtx }
      }

      const listWith = (spyCtx: AppContext) =>
        listRepoOps(
          spyCtx,
          { did: repoDid, limit: 100, excludeValues: false },
          callerSet('nerv'),
        )

      it('makes one state call and no label call when every candidate has a row', async () => {
        await actorStore.create(repoDid)
        await appendEvent(repoDid, REV.r1, [
          { action: 'create', path: `${POST}/ayanami`, cid: 'cidA' },
        ])
        await indexPost('ayanami')
        const { calls, ctx: spyCtx } = budgetCtx()

        await listWith(spyCtx)

        expect(calls.states).toBe(1)
        expect(calls.labels).toEqual([])
      })

      it('makes one state call and one label call, for the rowless URIs only', async () => {
        await actorStore.create(repoDid)
        await appendEvent(repoDid, REV.r1, [
          { action: 'create', path: `${POST}/ayanami`, cid: 'cidA' },
          { action: 'update', path: `${POST}/kaworu`, cid: 'cidB' },
          { action: 'create', path: `${POST}/shinji`, cid: 'cidC' },
        ])
        await indexPost('ayanami')
        const { calls, ctx: spyCtx } = budgetCtx()

        await listWith(spyCtx)

        expect(calls.states).toBe(1)
        expect(calls.labels).toEqual([[uriOf('kaworu'), uriOf('shinji')]])
      })

      it('makes neither call when the page has no create or update candidates', async () => {
        await actorStore.create(repoDid)
        await actorStore.transact(repoDid, async (store: any) => {
          await store.sequence.appendEvent({
            did: repoDid,
            eventType: 'append',
            event: encodeRecord({
              rev: REV.r1,
              ops: [
                {
                  action: 'delete',
                  path: `${POST}/ayanami`,
                  boundary: { values: [{ value: 'nerv' }] },
                },
              ],
            }),
            invalidated: 0,
            sequencedAt: new Date().toISOString(),
          })
        })
        const { calls, ctx: spyCtx } = budgetCtx()

        const res = await listWith(spyCtx)

        expect(res.ops.map((op) => op.rkey)).toEqual(['ayanami'])
        expect(calls.states).toBe(0)
        expect(calls.labels).toEqual([])
      })
    })

    it('rejects and returns no ops when the label read fails (e8)', async () => {
      await actorStore.create(repoDid)
      await appendEvent(repoDid, REV.r1, [
        { action: 'create', path: `${POST}/ayanami`, cid: 'cidA' },
        { action: 'create', path: `${POST}/kaworu`, cid: 'cidB' },
      ])
      await indexPost('ayanami')
      vi.spyOn(ctx.labelStore, 'latestTakedowns').mockRejectedValue(
        new Error('MAGI label log unreachable'),
      )

      await expect(
        listRepoOps(
          ctx,
          { did: repoDid, limit: 100, excludeValues: false },
          callerSet('nerv'),
        ),
      ).rejects.toThrow('MAGI label log unreachable')
    })

    it('looks up only the create and update URIs of a page (r6b)', async () => {
      await actorStore.create(repoDid)
      await appendEvent(repoDid, REV.r1, [
        { action: 'create', path: `${POST}/ayanami`, cid: 'cidA' },
        { action: 'update', path: `${POST}/soryu`, cid: 'cidB' },
        { action: 'delete', path: `${POST}/katsuragi` },
      ])
      const lookups: string[][] = []
      const spyCtx = {
        ...ctx,
        actorStore: {
          exists: (did: string) => actorStore.exists(did),
          read: (did: string, fn: (store: unknown) => unknown) =>
            actorStore.read(did, (store: any) =>
              fn({
                ...store,
                sequence: store.sequence,
                repo: store.repo,
                record: {
                  getTakedownStates: (uris: string[]) => {
                    lookups.push([...uris].sort())
                    return store.record.getTakedownStates(uris)
                  },
                },
              }),
            ),
        },
      } as unknown as AppContext

      const res = await listRepoOps(
        spyCtx,
        { did: repoDid, limit: 100, excludeValues: false },
        callerSet('nerv'),
      )

      expect(res.ops).toHaveLength(3)
      expect(lookups).toEqual([[uriOf('ayanami'), uriOf('soryu')]])
    })
  })

  // ── head-of-oplog signed commit ──────────────────────────────────────────

  describe('head-of-oplog signed commit', () => {
    it('includes the current signed commit, verifiable against the actor key', async () => {
      const { P256Keypair, verifySignature } = await import('@atproto/crypto')
      const { encode: encodeCbor, fromBytes } = await import('@atcute/cbor')
      const { buildCommit } = await import('@northskysocial/stratos-core')
      const { StratosBlockStoreReader, signAndPersistCommit } =
        await import('../src/features/index.js')
      const {
        parseCid,
        computeCid,
        encodeRecord: enc,
      } = await import('@northskysocial/stratos-core')

      const keypair = await P256Keypair.create({ exportable: true })
      await actorStore.create(repoDid)

      // Real write: build + sign + persist a commit so getRootDetailed returns it.
      const record = {
        text: 'signed',
        boundary: { values: [{ value: 'nerv' }] },
      }
      const recordBytes = enc(record)
      const recordCid = await computeCid(record)

      await actorStore.transact(repoDid, async (store: any) => {
        const storage = new StratosBlockStoreReader(store.repo)
        const unsigned = await buildCommit(storage, null, {
          did: repoDid,
          writes: [
            {
              action: 'create',
              collection: 'zone.stratos.feed.post',
              rkey: 'signed1',
              cid: parseCid(recordCid).toString(),
            },
          ],
        })
        await store.repo.putBlock(recordCid, recordBytes, unsigned.rev)
        // signAndPersistCommit takes a bound ActorSignFn, not a Keypair.
        await signAndPersistCommit(
          store.repo,
          (bytes: Uint8Array) => keypair.sign(bytes),
          unsigned,
        )
      })

      const commit = await readCurrentSignedCommit(ctx, repoDid)
      expect(commit).not.toBeNull()
      expect(commit!.did).toBe(repoDid)
      expect(commit!.version).toBe(3)

      // The head response carries the same commit.
      const res = await listRepoOps(
        ctx,
        { did: repoDid, limit: 100, excludeValues: false },
        callerSet('nerv'),
      )
      expect(res.cursor).toBeUndefined()
      expect(res.commit).toBeDefined()
      expect(res.commit!.rev).toBe(commit!.rev)

      // Verify the signature against the actor's known public key. The wire
      // commit carries CIDs as strings and the sig as base64; rebuild the
      // exact unsigned CBOR the signer produced ({did, version, data: $link,
      // rev, prev: null}) and decode the sig from its base64 form.
      const wire = res.commit!
      const unsignedBytes = encodeCbor({
        did: wire.did,
        version: wire.version,
        data: { $link: wire.data },
        rev: wire.rev,
        prev: null,
      })
      const sigBytes = fromBytes({ $bytes: wire.sig })
      const verified = await verifySignature(
        keypair.did(),
        unsignedBytes,
        sigBytes,
      )
      expect(verified).toBe(true)
    })
  })

  // ── recovery: inline/excludeValues ───────────────────────────────────────

  describe('listRecordPaths recovery', () => {
    it('inlines values by default and omits them with excludeValues', async () => {
      await actorStore.create(repoDid)
      await seedRecord(repoDid, 'zone.stratos.feed.post', 'a', 'nerv', 'v1')

      const inlined = await listRecordPaths(
        ctx,
        { did: repoDid, limit: 100, excludeValues: false },
        callerSet('nerv'),
      )
      expect(inlined.records).toHaveLength(1)
      expect((inlined.records[0].value as any).text).toBe('v1')

      const meta = await listRecordPaths(
        ctx,
        { did: repoDid, limit: 100, excludeValues: true },
        callerSet('nerv'),
      )
      expect(meta.records[0].value).toBeUndefined()
      expect(meta.records[0].cid).toBeDefined()
    })

    it('paginates across collections with a stable cursor', async () => {
      await actorStore.create(repoDid)
      await seedRecord(repoDid, 'zone.stratos.feed.post', 'a', 'nerv')
      await seedRecord(repoDid, 'zone.stratos.feed.post', 'b', 'nerv')
      await seedRecord(repoDid, 'zone.stratos.space.feed', 'c', 'nerv')

      const seen: string[] = []
      let cursor: string | undefined
      let guard = 0
      for (;;) {
        const res: any = await listRecordPaths(
          ctx,
          { did: repoDid, limit: 1, cursor, excludeValues: true },
          callerSet('nerv'),
        )
        for (const r of res.records) seen.push(r.rkey)
        cursor = res.cursor
        if (!cursor || guard++ > 20) break
      }
      expect(seen.sort()).toEqual(['a', 'b', 'c'])
    })
  })

  /** Seed a real indexed record (for listRecordPaths). */
  async function seedRecord(
    did: string,
    collection: string,
    rkey: string,
    boundary: string,
    text = 'hello',
  ) {
    const { computeCid, parseCid } =
      await import('@northskysocial/stratos-core')
    const record = {
      $type: collection,
      text,
      boundary: {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: [{ value: boundary }],
      },
    }
    const cid = parseCid((await computeCid(record)).toString())
    await actorStore.transact(did, async (store: any) => {
      await store.record.putRecord({
        uri: `at://${did}/${collection}/${rkey}`,
        cid,
        value: record,
        content: encodeRecord(record),
      })
    })
  }
})
