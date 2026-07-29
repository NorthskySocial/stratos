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
import {
  decodeSeqCursor,
  encodeSeqCursor,
  listRecordPaths,
  listRepoOps,
  OplogTruncatedError,
  readCurrentSignedCommit,
} from '../src/features/pull-sync/index.js'
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
    it('emits create/update/delete with correct cid/prev nullability, in order', async () => {
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

      expect(res.caughtUp).toBe(true)
      expect(res.ops.map((o) => o.rev)).toEqual([
        REV.r1,
        REV.r2,
        REV.r3,
        REV.r3,
      ])
      // create: cid present, prev null
      expect(res.ops[0]).toMatchObject({
        collection: 'zone.stratos.feed.post',
        rkey: 'a',
        cid: 'cidA1',
        prev: null,
      })
      // update: cid present (prev null here since prior value not in-window)
      expect(res.ops[1]).toMatchObject({ rkey: 'b', cid: 'cidB1' })
      // delete: cid null
      const del = res.ops.find((o) => o.rkey === 'c')!
      expect(del).toMatchObject({ rkey: 'c', cid: null, rev: REV.r3 })
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
      expect(res.caughtUp).toBe(true)
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
      // must not silently return caughtUp - the syncer would diverge with no
      // path back to recovery.
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
      expect(res.caughtUp).toBe(true)
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
      // and report a false caught-up.
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
          read: async (_did: string, fn: (store: unknown) => unknown) =>
            fn({
              sequence: {
                getOldestSeq: async () => 10,
                getLatestSeq: async () => 12,
                getEventsSince: async (after: number, limit = 100) =>
                  rows.filter((r) => r.seq > after).slice(0, limit),
              },
              // No commits yet - the caught-up path tolerates a missing root.
              repo: { getRootDetailed: async () => null },
            }),
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
      expect(res.caughtUp).toBe(true)
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
      let caughtUp = false
      let guard = 0
      while (!caughtUp && guard++ < 20) {
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
        caughtUp = res.caughtUp
      }

      // Every seeded op appears exactly once; the late one appears too, once.
      const counts = seen.reduce<Record<string, number>>((m, k) => {
        m[k] = (m[k] ?? 0) + 1
        return m
      }, {})
      for (const k of ['p0', 'p1', 'p2', 'p3', 'p4', 'late']) {
        expect(counts[k]).toBe(1)
      }
      expect(caughtUp).toBe(true)
    })
  })

  // ── caughtUp signed commit ───────────────────────────────────────────────

  describe('caughtUp signed commit', () => {
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

      // caughtUp response carries the same commit.
      const res = await listRepoOps(
        ctx,
        { did: repoDid, limit: 100, excludeValues: false },
        callerSet('nerv'),
      )
      expect(res.caughtUp).toBe(true)
      expect(res.commit).toBeDefined()
      expect(res.commit!.rev).toBe(commit!.rev)

      // Verify the signature against the actor's known public key.
      const { sig, ...rest } = res.commit as any
      const unsignedBytes = encodeCbor(rest)
      const sigBytes = fromBytes(sig)
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
