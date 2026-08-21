import { describe, expect, it } from 'vitest'
import { encode as cborEncode, toBytes as cborToBytes } from '@atcute/cbor'
import {
  computeCid,
  encodeRecord,
  parseCid,
} from '@northskysocial/stratos-core'
import type { AppContext } from '../src/context.js'
import {
  encodeSeqCursor,
  listRepoOps,
} from '../src/features/pull-sync/index.js'

const REPO_DID = 'did:plc:tenchi-masaki'
const BOUNDARY = 'jurai'
const REV = {
  r1: '3aaaa000000t1',
  r2: '3bbbb000000t2',
  r3: '3cccc000000t3',
}

interface SeqRow {
  seq: number
  did: string
  event: Uint8Array
  sequencedAt: string
}

/**
 * Sequence rows and the repo root are read through separate `actorStore.read`
 * calls, so a scripted store is the only way to land a write in the window
 * between them deterministically.
 */
class ScriptedActorStore {
  readonly rows: SeqRow[] = []
  root: { cid: string; rev: string } | null = null
  commitBytes: Uint8Array | null = null
  /** Fired when the commit read happens, to simulate a concurrent write. */
  onCommitRead: () => void = () => {}
  /** Fired after a sequence page is captured, before it is returned. */
  onSequenceRead: () => void = () => {}

  appendEvent(seq: number, rev: string, rkey: string, cid: string): void {
    this.rows.push({
      seq,
      did: REPO_DID,
      event: encodeRecord({
        rev,
        ops: [
          {
            action: 'create',
            path: `zone.stratos.feed.post/${rkey}`,
            cid,
            record: {
              text: 'washu built it',
              boundary: { values: [{ value: BOUNDARY }] },
            },
          },
        ],
      }),
      sequencedAt: new Date().toISOString(),
    })
  }

  /** Append a malformed non-delete op that has no cid. */
  appendCidlessCreate(seq: number, rev: string, rkey: string): void {
    this.rows.push({
      seq,
      did: REPO_DID,
      event: encodeRecord({
        rev,
        ops: [
          {
            action: 'create',
            path: `zone.stratos.feed.post/${rkey}`,
            record: {
              text: 'kagato corrupted it',
              boundary: { values: [{ value: BOUNDARY }] },
            },
          },
        ],
      }),
      sequencedAt: new Date().toISOString(),
    })
  }

  async exists(): Promise<boolean> {
    return true
  }

  async read<T>(_did: string, fn: (store: unknown) => Promise<T>): Promise<T> {
    return fn({
      sequence: {
        getOldestSeq: async () => this.rows[0]?.seq ?? 0,
        getLatestSeq: async () => this.rows[this.rows.length - 1]?.seq ?? 0,
        getEventsSince: async (cursor: number, limit = 100) => {
          // Capture the page before the hook runs, so a write appended by the
          // hook lands strictly after this read.
          const page = this.rows
            .filter((row) => row.seq > cursor)
            .slice(0, limit)
          this.onSequenceRead()
          return page
        },
      },
      repo: {
        getRootDetailed: async () => {
          this.onCommitRead()
          return this.root
        },
        getBytes: async () => this.commitBytes,
      },
    })
  }
}

async function encodeSignedCommit(rev: string): Promise<Uint8Array> {
  const dataCid = parseCid(await computeCid({ mst: 'root' })).toString()
  return cborEncode({
    did: REPO_DID,
    version: 3,
    data: { $link: dataCid },
    rev,
    prev: null,
    sig: cborToBytes(new Uint8Array([0xca, 0xbb, 0x1e])),
  })
}

function makeCtx(actorStore: ScriptedActorStore): AppContext {
  return { actorStore } as unknown as AppContext
}

describe('listRepoOps head-of-oplog race', () => {
  const params = { did: REPO_DID, limit: 100, excludeValues: false }
  const callerBoundaries: ReadonlySet<string> = new Set([BOUNDARY])

  it('returns a cursor, not a commit, when a write lands during the commit read', async () => {
    const actorStore = new ScriptedActorStore()
    actorStore.appendEvent(1, REV.r1, 'ryoko', 'cidRyoko')
    actorStore.root = { cid: 'commitCid', rev: REV.r1 }
    actorStore.commitBytes = await encodeSignedCommit(REV.r2)
    // The concurrent write becomes visible only after the commit was read, so
    // the commit reflects rev r2 while the ops page stops at r1.
    actorStore.onCommitRead = () => {
      if (actorStore.rows.length === 1) {
        actorStore.appendEvent(2, REV.r2, 'ayeka', 'cidAyeka')
      }
    }

    const res = await listRepoOps(makeCtx(actorStore), params, callerBoundaries)

    expect(res.commit).toBeUndefined()
    expect(res.cursor).toBe(encodeSeqCursor(1))
    expect(res.ops.map((op) => op.rev)).toEqual([REV.r1])
  })

  it('can return no ops and the same cursor the caller sent', async () => {
    const actorStore = new ScriptedActorStore()
    actorStore.appendEvent(1, REV.r1, 'ryoko', 'cidRyoko')
    actorStore.root = { cid: 'commitCid', rev: REV.r1 }
    actorStore.commitBytes = await encodeSignedCommit(REV.r2)
    actorStore.onCommitRead = () => {
      if (actorStore.rows.length === 1) {
        actorStore.appendEvent(2, REV.r2, 'sasami', 'cidSasami')
      }
    }

    // The caller already holds seq 1, so the log drains with no ops and
    // `lastSeq` stays at the incoming cursor. The response then repeats that
    // cursor and makes no progress. Pinned here because both the JSDoc and the
    // client docs once promised that every response advances the cursor.
    const cursor = encodeSeqCursor(1)
    const res = await listRepoOps(
      makeCtx(actorStore),
      { ...params, cursor },
      callerBoundaries,
    )

    expect(res.ops).toEqual([])
    expect(res.cursor).toBe(cursor)
  })

  it('stays at the head when the write lands after the probe', async () => {
    const actorStore = new ScriptedActorStore()
    actorStore.appendEvent(1, REV.r1, 'ryoko', 'cidRyoko')
    actorStore.root = { cid: 'commitCid', rev: REV.r1 }
    actorStore.commitBytes = await encodeSignedCommit(REV.r1)
    // The probe is the only sequence read that happens after the commit read,
    // and its page is captured before this hook runs. The write therefore lands
    // strictly past the probe's horizon, where one probe cannot see it. Ops and
    // commit still agree, so the response is consistent rather than a false
    // head signal — the write simply belongs to a later poll.
    let commitRead = false
    actorStore.onCommitRead = () => {
      commitRead = true
    }
    actorStore.onSequenceRead = () => {
      if (commitRead && actorStore.rows.length === 1) {
        actorStore.appendEvent(2, REV.r2, 'mihoshi', 'cidMihoshi')
      }
    }

    const res = await listRepoOps(makeCtx(actorStore), params, callerBoundaries)

    expect(res.cursor).toBeUndefined()
    expect(res.commit?.rev).toBe(REV.r1)
    expect(res.ops.map((op) => op.rev)).toEqual([REV.r1])
  })

  it('returns the commit and no cursor when no write lands during the commit read', async () => {
    const actorStore = new ScriptedActorStore()
    actorStore.appendEvent(1, REV.r1, 'ryoko', 'cidRyoko')
    actorStore.root = { cid: 'commitCid', rev: REV.r1 }
    actorStore.commitBytes = await encodeSignedCommit(REV.r1)

    const res = await listRepoOps(makeCtx(actorStore), params, callerBoundaries)

    expect(res.cursor).toBeUndefined()
    expect(res.commit?.rev).toBe(REV.r1)
    expect(res.ops.map((op) => op.rev)).toEqual([REV.r1])
  })

  it('withholds the commit when the op budget ends the page at the last event', async () => {
    const actorStore = new ScriptedActorStore()
    actorStore.appendEvent(1, REV.r1, 'ryoko', 'cidRyoko')
    actorStore.root = { cid: 'commitCid', rev: REV.r1 }
    actorStore.commitBytes = await encodeSignedCommit(REV.r1)

    const res = await listRepoOps(
      makeCtx(actorStore),
      { ...params, limit: 1 },
      callerBoundaries,
    )

    expect(res.commit).toBeUndefined()
    expect(res.cursor).toBe(encodeSeqCursor(1))
  })

  it('signals the head with no commit and no cursor for a repo with no root yet', async () => {
    const actorStore = new ScriptedActorStore()

    const res = await listRepoOps(makeCtx(actorStore), params, callerBoundaries)

    expect(res.commit).toBeUndefined()
    expect(res.cursor).toBeUndefined()
    expect(res.ops).toEqual([])
  })

  it('drops a malformed non-delete op without a cid and keeps the rest', async () => {
    const actorStore = new ScriptedActorStore()
    // `cid: null` on the wire means delete, so a cid-less create cannot be
    // emitted truthfully — expandEventOps must fail closed and drop it.
    actorStore.appendCidlessCreate(1, REV.r1, 'kagato')
    actorStore.appendEvent(2, REV.r2, 'ryoko', 'cidRyoko')
    actorStore.root = { cid: 'commitCid', rev: REV.r2 }
    actorStore.commitBytes = await encodeSignedCommit(REV.r2)

    const res = await listRepoOps(makeCtx(actorStore), params, callerBoundaries)

    expect(res.ops.map((op) => op.rkey)).toEqual(['ryoko'])
    expect(res.cursor).toBeUndefined()
    expect(res.commit?.rev).toBe(REV.r2)
  })

  it('drops ops whose record key fails the record-key format and keeps the rest', async () => {
    const actorStore = new ScriptedActorStore()
    // `..` and an empty rkey (a path with a trailing slash) both fail the
    // record-key format, so these ops cannot pass output validation.
    actorStore.appendEvent(1, REV.r1, '..', 'cidKagato')
    actorStore.appendEvent(2, REV.r2, '', 'cidYosho')
    actorStore.appendEvent(3, REV.r3, 'ryoko', 'cidRyoko')
    actorStore.root = { cid: 'commitCid', rev: REV.r3 }
    actorStore.commitBytes = await encodeSignedCommit(REV.r3)

    const res = await listRepoOps(makeCtx(actorStore), params, callerBoundaries)

    expect(res.ops.map((op) => op.rkey)).toEqual(['ryoko'])
    expect(res.cursor).toBeUndefined()
    expect(res.commit?.rev).toBe(REV.r3)
  })
})
