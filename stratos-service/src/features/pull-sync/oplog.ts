import { decode as cborDecode } from '@atcute/cbor'
import type { AppContext } from '../../context.js'
import {
  decodeEvent,
  type DecodedEvent,
  type RecordOp,
} from '../../subscription/index.js'
import {
  getSequenceBounds,
  readSequencePage,
  SEQUENCE_DB_PAGE_SIZE,
} from '../../subscription/sequence-paging.js'

/**
 * Distinct error signalling that the requested `since` revision is unknown or
 * predates retained history (compacted). The caller must fall back to
 * full-state recovery (listRecordPaths). Mapped to the `OplogTruncated` XRPC
 * error name by the handler.
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
  cid: string | null
  prev: string | null
  value?: unknown
}

/**
 * A signed MST v3 commit, decoded verbatim from the persisted commit block.
 * Never re-signed.
 */
export interface SignedCommit {
  did: string
  version: number
  data: unknown
  rev: string
  prev: unknown
  sig: unknown
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
  cursor?: string
  caughtUp: boolean
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
    const decoded = cborDecode(bytes) as Record<string, unknown>
    return {
      did: decoded.did as string,
      version: decoded.version as number,
      data: decoded.data,
      rev: decoded.rev as string,
      prev: decoded.prev ?? null,
      sig: decoded.sig,
    }
  })
}

/**
 * An expanded op carrying the source `action` so the coalescing pass can derive
 * `prev` faithfully. `action` is internal and stripped from the wire result.
 */
interface ExpandedOp extends RepoOp {
  action: 'create' | 'update' | 'delete'
}

/**
 * Expand a decoded event into per-op entries, all sharing the event's `rev`.
 * Deletes carry `cid: null`. The `prev` field is derived by the coalescing pass
 * ({@link coalesceCurrentValues}): the true superseded CID is used when the
 * prior op is present in the returned window, otherwise the op `action` decides
 * create (`prev: null`) vs update/delete (`prev` present as an empty sentinel is
 * NOT emitted — see coalescer). The `action` is retained here only for that
 * derivation and never reaches the wire.
 *
 * @param decoded - Event decoded via {@link decodeEvent}
 * @param rev - The shared revision for all ops in this event
 * @returns One expanded op per record op in the event
 */
function expandEventOps(decoded: DecodedEvent, rev: string): ExpandedOp[] {
  return decoded.ops.map((op: RecordOp) => {
    const { collection, rkey } = splitPath(op.path)
    const isDelete = op.action === 'delete'
    return {
      rev,
      collection,
      rkey,
      cid: isDelete ? null : (op.cid ?? null),
      prev: null,
      value: isDelete ? undefined : op.record,
      action: op.action,
    }
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
): Promise<{ ops: ExpandedOp[]; lastSeq: number; drained: boolean }> {
  const { did, since, limit } = params
  const collected: ExpandedOp[] = []
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

      // `since` start-mapping: skip events up to and including `rev === since`.
      // TIDs sort lexicographically, so emit only events with `rev > since`.
      if (!located) {
        if (since !== undefined && event.rev <= since) {
          continue
        }
        located = true
      }

      const decoded = decodeEvent(event)
      // Fail closed: an undecodable event has unverifiable boundaries — drop it
      // entirely (do not leak its existence, including deletes).
      if (!decoded.decodeOk) continue
      if (!isEventInScope(decoded, callerBoundaries)) continue

      // Emit a whole event's ops atomically (they share one rev); never split a
      // batch across a page boundary.
      collected.push(...expandEventOps(decoded, event.rev))

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
 * Whether a decoded event is in scope for a caller holding `callerBoundaries`.
 * Same fail-closed semantics as the subscribeRecords in-stream gate: an event
 * whose payload could not be decoded, or that shares no boundary with the
 * caller, is denied — this also filters DELETES for out-of-scope records,
 * preventing an existence leak.
 *
 * @param decoded - Event decoded via {@link decodeEvent}
 * @param callerBoundaries - The caller's enrolled boundaries
 * @returns True if the caller may observe this event's ops
 */
function isEventInScope(
  decoded: DecodedEvent,
  callerBoundaries: ReadonlySet<string>,
): boolean {
  if (!decoded.decodeOk) return false
  return decoded.boundaries.some((b) => callerBoundaries.has(b))
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
  ops: ExpandedOp[],
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

    // `prev`: prefer the actual superseded CID when we've seen the prior op in
    // this window; otherwise fall back to the op action — a create has no prev,
    // an update/delete had a prior value we cannot name (prev stays null but the
    // op is not misrepresented as it still carries its own cid/value).
    let prev: string | null = null
    if (priorCid !== undefined) {
      prev = priorCid
    }

    const entry: RepoOp = {
      rev: op.rev,
      collection: op.collection,
      rkey: op.rkey,
      cid: op.cid,
      prev,
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
 * when the log is drained — attaches the repo's current signed commit and marks
 * `caughtUp`.
 *
 * @param ctx - Application context
 * @param params - Resolved listRepoOps params
 * @param callerBoundaries - The caller's enrolled boundaries
 * @returns The page result
 * @throws OplogTruncatedError when `since` is unknown/compacted
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
    startSeq = cursorSeq
    // A cursor is only ever issued AFTER `since` was located, so continuing
    // from a cursor means we are already past the `since` boundary.
    sinceLocated = true
  } else if (since !== undefined) {
    // Fresh request with `since`: OplogTruncated if `since` predates the oldest
    // retained event. When the log is empty there is nothing to truncate.
    if (
      bounds !== null &&
      bounds.oldestRev !== '' &&
      since < bounds.oldestRev
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
    return {
      ops: coalesced,
      caughtUp: true,
      // `commit` is REQUIRED when caughtUp; it may be null only for a repo with
      // no root yet (no writes), in which case there are also no ops to sync.
      ...(commit ? { commit } : {}),
    }
  }

  return {
    ops: coalesced,
    cursor: encodeSeqCursor(lastSeq),
    caughtUp: false,
  }
}
