import { decode as cborDecode } from '@atcute/cbor'
import type { AppContext } from '../../context.js'
import {
  decodeEvent,
  type DecodedEvent,
  eventInScope,
  type RecordOp,
} from '../../subscription/index.js'
import {
  getSequenceBounds,
  readSequencePage,
  SEQUENCE_DB_PAGE_SIZE,
} from '../../subscription/sequence-paging.js'

/**
 * Distinct error signalling that the oplog cannot serve the requested window
 * truthfully: the `since`/cursor position is unknown or compacted, or a
 * retained op cannot be emitted. The caller must fall back to full-state
 * recovery (listRecordPaths). Mapped to the `OplogTruncated` XRPC error name
 * by the handler.
 */
export class OplogTruncatedError extends Error {
  constructor(message = 'since revision predates retained history') {
    super(message)
    this.name = 'OplogTruncatedError'
  }
}

/**
 * A single oplog operation in the wire shape of
 * `zone.stratos.sync.listRepoOps#repoOp`.
 * - `cid` null ⇒ delete
 * - `prev` null ⇒ create
 * Atomic multi-writes share one `rev`.
 */
export interface RepoOp {
  rev: string
  collection: string
  rkey: string
  /** CID of the current record value. Null for a delete. */
  cid: string | null
  /**
   * CID of the superseded value. Null for a create, or when the superseded
   * value predates the returned window.
   */
  prev: string | null
  value?: unknown
}

/**
 * A signed MST v3 commit, decoded verbatim from the persisted commit block and
 * serialized to lex-JSON-safe primitives (CIDs as strings, signature as
 * base64). Never re-signed.
 */
export interface SignedCommit {
  did: string
  version: number
  /** CID (string form) of the MST root node. */
  data: string
  rev: string
  /** CID (string form) of the previous commit. ABSENT for the first commit. */
  prev?: string
  /** Commit signature, base64 of the exact persisted bytes. */
  sig: string
}

export interface ListRepoOpsParams {
  did: string
  since?: string
  limit: number
  cursor?: string
  excludeValues: boolean
}

export interface ListRepoOpsResult {
  ops: RepoOp[]
  /** Absent once the response reaches the head of the oplog. */
  cursor?: string
  /** Included at the head of the oplog, unless the repo has no commits yet. */
  commit?: SignedCommit
}

const CURSOR_PREFIX = 'seq:'

/**
 * Encode an opaque pagination cursor from a `seq`.
 * @param seq - The last-processed sequence number
 * @returns Opaque base64url cursor string
 */
export function encodeSeqCursor(seq: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${seq}`, 'utf8').toString('base64url')
}

/**
 * Decode an opaque pagination cursor back to its `seq`.
 * @param cursor - Opaque cursor produced by {@link encodeSeqCursor}
 * @returns The encoded sequence number, or null when malformed
 */
export function decodeSeqCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    if (!decoded.startsWith(CURSOR_PREFIX)) return null
    const n = Number(decoded.slice(CURSOR_PREFIX.length))
    if (!Number.isInteger(n) || n < 0) return null
    return n
  } catch {
    return null
  }
}

/**
 * Extract `{collection, rkey}` from a canonical `collection/rkey` op path.
 * @param path - The op path (no leading slash), e.g. `app.bsky.feed.post/abc`
 * @returns The split collection and rkey (rkey may be empty for malformed paths)
 */
function splitPath(path: string): { collection: string; rkey: string } {
  const slash = path.indexOf('/')
  if (slash === -1) return { collection: path, rkey: '' }
  return { collection: path.slice(0, slash), rkey: path.slice(slash + 1) }
}

/**
 * Read and decode the repo's CURRENT signed commit block verbatim.
 * We READ the persisted, already-signed commit (via getRootDetailed + getBytes)
 * and CBOR-decode it — we never re-sign. Returns null when the repo has no root.
 *
 * @param ctx - Application context
 * @param did - The repo DID
 * @returns The decoded signed commit, or null when absent
 */
export async function readCurrentSignedCommit(
  ctx: AppContext,
  did: string,
): Promise<SignedCommit | null> {
  if (!(await ctx.actorStore.exists(did))) return null
  return await ctx.actorStore.read(did, async (store) => {
    const root = await store.repo.getRootDetailed()
    if (!root) return null
    const bytes = await store.repo.getBytes(root.cid)
    if (!bytes) return null
    // Normalize decoder wrapper types (CID links, byte strings) to plain lex
    // JSON via a JSON round trip, then flatten to primitives: the XRPC layer
    // cannot serialize foreign wrapper classes, and the response contract
    // carries CIDs as strings and the signature as base64.
    const decoded = JSON.parse(JSON.stringify(cborDecode(bytes))) as Record<
      string,
      unknown
    >
    const link = (v: unknown): string | null =>
      v && typeof v === 'object' && '$link' in v
        ? String((v as { $link: unknown }).$link)
        : null
    const sigBytes = decoded.sig as { $bytes?: unknown } | undefined
    const sig = sigBytes?.$bytes
    const prev = link(decoded.prev)
    return {
      did: decoded.did as string,
      version: decoded.version as number,
      data: link(decoded.data) ?? String(decoded.data),
      rev: decoded.rev as string,
      // Optional lexicon fields must be ABSENT, never null.
      ...(prev !== null ? { prev } : {}),
      sig: typeof sig === 'string' ? sig : '',
    }
  })
}

/**
 * The `record-key` string format: 1-512 chars from the permitted set, and not
 * the literal `.` or `..` path segments.
 */
const RECORD_KEY_RE = /^[A-Za-z0-9._~:-]{1,512}$/

function isValidRecordKey(rkey: string): boolean {
  return rkey !== '.' && rkey !== '..' && RECORD_KEY_RE.test(rkey)
}

/**
 * Expand a decoded event into per-op `RepoOp` entries, all sharing the event's
 * `rev`. Deletes carry `cid: null`. `prev` starts as null here and the
 * coalescing pass ({@link coalesceCurrentValues}) derives it from the prior op
 * for the same path within the returned window.
 *
 * @param ctx - Application context (for diagnostics)
 * @param did - The repo DID (for diagnostics)
 * @param decoded - Event decoded via {@link decodeEvent}
 * @param rev - The shared revision for all ops in this event
 * @returns One expanded op per record op in the event
 * @throws OplogTruncatedError when a persisted op cannot be emitted truthfully
 */
function expandEventOps(
  ctx: AppContext,
  did: string,
  decoded: DecodedEvent,
  rev: string,
): RepoOp[] {
  return decoded.ops.flatMap((op: RecordOp) => {
    const { collection, rkey } = splitPath(op.path)
    const isDelete = op.action === 'delete'
    // Fail closed on a malformed non-delete without a cid: `cid: null` on the
    // wire means delete, so this op cannot be emitted truthfully. A silent
    // drop would let the page reach a head response that omits a persisted op
    // - a permanent sync gap. Signal truncation instead: the caller falls
    // back to full-state recovery and resumes past this event.
    const cid = isDelete ? null : (op.cid ?? undefined)
    if (cid === undefined) {
      ctx.logger?.warn(
        { did, collection, rev },
        'pull-sync found an op with no cid',
      )
      throw new OplogTruncatedError('oplog contains an op with no cid')
    }
    // Fail closed on an invalid record key: the response schema requires the
    // record-key format, so this op cannot pass output validation. Same
    // reasoning as above - truncation, not a silent drop.
    if (!isValidRecordKey(rkey)) {
      ctx.logger?.warn(
        { did, collection, rev },
        'pull-sync found an op with an invalid record key',
      )
      throw new OplogTruncatedError(
        'oplog contains an op with an invalid record key',
      )
    }
    return [
      {
        rev,
        collection,
        rkey,
        cid,
        prev: null,
        value: isDelete ? undefined : op.record,
      },
    ]
  })
}

/**
 * Page the actor sequence log for {@link listRepoOps}, applying the `since`
 * start-mapping, boundary gating (fail-closed, including delete-filtering) and
 * per-op expansion of atomic batches. Stops when `limit` ops are collected or
 * the log is drained.
 *
 * @param ctx - Application context
 * @param params - Resolved listRepoOps params
 * @param startSeq - The `seq` to resume strictly after (0 for beginning)
 * @param sinceLocated - Whether the `since` boundary has already been passed
 * @param callerBoundaries - The caller's enrolled boundaries
 * @returns Collected ops, the last processed seq, and whether the log drained
 */
async function collectOps(
  ctx: AppContext,
  params: ListRepoOpsParams,
  startSeq: number,
  sinceLocated: boolean,
  callerBoundaries: ReadonlySet<string>,
): Promise<{ ops: RepoOp[]; lastSeq: number; drained: boolean }> {
  const { did, since, limit } = params
  const collected: RepoOp[] = []
  let afterSeq = startSeq
  let located = sinceLocated
  let drained = false
  // Whether we stopped early because the op budget was reached at an event
  // boundary (⇒ more may remain even if this page was short).
  let hitLimit = false

  while (true) {
    const page = await readSequencePage(ctx, did, afterSeq)
    if (page.length === 0) {
      drained = true
      break
    }

    for (const event of page) {
      afterSeq = event.seq

      // Fail closed on a malformed revision: an event whose `rev` did not
      // decode to a valid TID (rev === '') cannot be ordered against `since`
      // nor emitted as a lexicon-valid op — drop it entirely.
      if (event.rev === '') continue

      // `since` start-mapping: skip events up to and including `rev === since`.
      // TIDs sort lexicographically, so emit only events with `rev > since`.
      if (!located) {
        if (since !== undefined && event.rev <= since) {
          continue
        }
        located = true
      }

      const decoded = decodeEvent(event)
      // Boundary gating shares the subscribeRecords in-stream predicate: it
      // FAILS CLOSED (an undecodable event has unverifiable boundaries and is
      // dropped entirely, deletes included - no existence leak) and suppresses
      // a move's scoped removal for callers who still see the record.
      if (!eventInScope(decoded, callerBoundaries)) continue

      // Emit a whole event's ops atomically (they share one rev); never split a
      // batch across a page boundary.
      collected.push(...expandEventOps(ctx, did, decoded, event.rev))

      if (collected.length >= limit) {
        hitLimit = true
        break
      }
    }

    if (hitLimit) break

    if (page.length < SEQUENCE_DB_PAGE_SIZE) {
      drained = true
      break
    }
  }

  return { ops: collected, lastSeq: afterSeq, drained }
}

/**
 * Coalesce ops to CURRENT-VALUE-ONLY per path: when the same `collection/rkey`
 * appears more than once in this page, the LATEST op wins and earlier
 * (stale) values are dropped, while each surviving op keeps its own `rev`.
 * Also derives `prev`: an op is a create (`prev: null`) unless a prior op for
 * the same path in this page already produced a value (⇒ update, `prev` = that
 * value's cid).
 *
 * The relative order of surviving paths (by first appearance) is preserved so
 * the page stays in ascending-rev order.
 *
 * @param ops - Expanded per-op entries in ascending order
 * @param excludeValues - When true, strip inlined values
 * @returns The coalesced, current-value-only ops
 */
function coalesceCurrentValues(
  ops: RepoOp[],
  excludeValues: boolean,
): RepoOp[] {
  // Track, per path, the last cid we emitted for that path within this window
  // (to derive the true `prev`), and the index of the surviving entry so a
  // later op supersedes it in place.
  const lastCidForPath = new Map<string, string | null>()
  const survivorIndex = new Map<string, number>()
  const result: RepoOp[] = []

  for (const op of ops) {
    const path = `${op.collection}/${op.rkey}`
    const priorCid = lastCidForPath.get(path)

    // `prev`: the actual superseded CID when we've seen the prior op in this
    // window; otherwise NULL - a create has no prev, a re-create after a
    // delete supersedes nothing, and an update/delete whose prior value
    // predates the window cannot name it.
    const entry: RepoOp = {
      rev: op.rev,
      collection: op.collection,
      rkey: op.rkey,
      cid: op.cid,
      prev: priorCid ?? null,
      value: op.value,
    }

    const existingIdx = survivorIndex.get(path)
    if (existingIdx !== undefined) {
      // Supersede the earlier (stale) op for this path in place. The surviving
      // op keeps ITS OWN `prev` — the CID it immediately superseded — so a
      // syncer learns both the current cid and what it replaced.
      result[existingIdx] = entry
    } else {
      survivorIndex.set(path, result.length)
      result.push(entry)
    }
    lastCidForPath.set(path, op.cid)
  }

  if (excludeValues) {
    for (const op of result) delete op.value
  }
  return result
}

/**
 * Execute a listRepoOps pull-sync page.
 *
 * Resolves the `since` start-mapping (returning {@link OplogTruncatedError} when
 * `since` predates retained history), pages the sequence log with fail-closed
 * boundary gating and delete-filtering, coalesces to current-value-only, and —
 * when the log is drained and the post-commit probe finds no newer sequence row
 * — reaches the head: the cursor is OMITTED and the repo's current signed
 * commit is attached. A drained log can still yield a cursor (no commit) when
 * the probe detects a write; under continuous writes the head may never be
 * reached. Such a response can carry no ops and repeat the cursor the caller
 * sent, so it does not always make progress. A caller must poll again while a
 * cursor is present, and must not read an unchanged cursor as a stall. A
 * cursor-free response always pairs the ops with a commit that matches them
 * (unless the repo has no commits yet); a write committing after the probe is
 * not detected and arrives on a later poll.
 *
 * @param ctx - Application context
 * @param params - Resolved listRepoOps params
 * @param callerBoundaries - The caller's enrolled boundaries
 * @returns The page result
 * @throws OplogTruncatedError when `since`/cursor is unknown or compacted, or
 *   a retained op cannot be emitted truthfully
 */
export async function listRepoOps(
  ctx: AppContext,
  params: ListRepoOpsParams,
  callerBoundaries: ReadonlySet<string>,
): Promise<ListRepoOpsResult> {
  const { did, since, cursor, excludeValues } = params

  const bounds = await getSequenceBounds(ctx, did)

  // Resolve resume point + whether `since` has already been located.
  let startSeq = 0
  let sinceLocated = since === undefined
  if (cursor !== undefined) {
    const cursorSeq = decodeSeqCursor(cursor)
    if (cursorSeq === null) {
      throw new OplogTruncatedError('malformed cursor')
    }
    // The next event we owe the caller is `cursorSeq + 1`. If compaction has
    // advanced past it between pages, the intervening ops are gone — silently
    // resuming would skip them and report a false caught-up. Fail closed into
    // full-state recovery.
    if (bounds === null || bounds.oldestSeq > cursorSeq + 1) {
      throw new OplogTruncatedError('cursor predates retained history')
    }
    // A cursor past the newest retained event names a seq this log did not
    // issue (for example after a log reset). Silently resuming would report a
    // false caught-up. Fail closed into full-state recovery.
    if (cursorSeq > bounds.latestSeq) {
      throw new OplogTruncatedError('cursor is beyond retained history')
    }
    startSeq = cursorSeq
    // A cursor is only ever issued AFTER `since` was located, so continuing
    // from a cursor means we are already past the `since` boundary.
    sinceLocated = true
  } else if (since !== undefined) {
    // Fresh request with `since`. `since` is a POSITION in rev-time (TIDs sort
    // lexicographically; events with `rev > since` are returned) — it need not
    // name a retained event. It is only trusted inside the retained window
    // [oldestRev, newestRev]: below it, the history the caller needs was
    // compacted away; above it (or with no retained log, or undecodable
    // bounds), it cannot be a rev this repo issued — silently returning a
    // head response would let a diverged syncer conclude it is up to date.
    // All cases fail closed into full-state recovery.
    if (
      bounds === null ||
      bounds.oldestRev === '' ||
      bounds.newestRev === '' ||
      since < bounds.oldestRev ||
      since > bounds.newestRev
    ) {
      throw new OplogTruncatedError()
    }
  }

  const { ops, lastSeq, drained } = await collectOps(
    ctx,
    params,
    startSeq,
    sinceLocated,
    callerBoundaries,
  )

  const coalesced = coalesceCurrentValues(ops, excludeValues)

  if (drained) {
    const commit = await readCurrentSignedCommit(ctx, did)
    // A write may have landed between the final ops page and the commit read
    // above, leaving a commit that does not correspond to the returned ops.
    // Probing `seq > lastSeq` detects this only because of two write-path
    // invariants: (1) every write persists its sequence rows and its root
    // update in one transaction, and (2) same-actor writers are serialized by
    // the stratos_repo_root row lock (lockRoot's SELECT ... FOR UPDATE
    // NOWAIT), which keeps per-actor seq assignment order aligned with commit
    // order — without (2), a lower seq could commit after a higher one and
    // slip past the probe. A hit means "not at the head after all": hand back
    // a cursor; the caller must simply poll again.
    const probe = await readSequencePage(ctx, did, lastSeq, 1)
    if (probe.length > 0) {
      return { ops: coalesced, cursor: encodeSeqCursor(lastSeq) }
    }
    return {
      ops: coalesced,
      // Head of the oplog: the cursor is omitted. `commit` is present EXCEPT
      // for a repo with no root yet (no writes) — there is nothing to sign and
      // also no ops to sync. The lexicon documents this no-commit exception.
      ...(commit ? { commit } : {}),
    }
  }

  return { ops: coalesced, cursor: encodeSeqCursor(lastSeq) }
}
