import { isValidNsidStr, isValidRkey } from '@northskysocial/stratos-core'
import type { FeedgenStore } from '../db/index.js'
import {
  extractBlobRefs,
  pickSortAt,
  STRATOS_POST_COLLECTION,
} from '../subscription/indexer.js'
import type { SpaceCredentialManager } from '../space-credential/index.js'
import {
  SpaceHostClient,
  type RepoOpEntry,
  type SpaceHostClientOptions,
} from './host-client.js'
import { MalformedCursorError } from './errors.js'
import type { PollTarget } from './membership.js'

/** Matches `FEEDGEN_SPACE_SYNC_MAX_RECORD_BYTES`'s planned default (WP6). */
const DEFAULT_MAX_RECORD_BYTES = 65_536
/** Pages fetched per target per pass, regardless of how many ops each page holds. */
const DEFAULT_MAX_PAGES = 10
/**
 * Indexed-record cap per member per pass. Set well above what the default
 * page settings (`DEFAULT_MAX_PAGES` pages of the host's own ~100-op page
 * default) would ever reach, so it rarely binds — it exists as an
 * independent circuit breaker, not the primary bound.
 */
const DEFAULT_MAX_RECORDS_PER_MEMBER = 1000

export interface SpaceSyncerDeps {
  store: Pick<
    FeedgenStore,
    | 'upsertPost'
    | 'deletePost'
    | 'getSpaceCursor'
    | 'upsertSpaceCursor'
    | 'deleteSpaceCursor'
  >
  credentialManager: Pick<SpaceCredentialManager, 'getCredential'>
  /** Injectable host-client factory (test seam). Defaults to `new SpaceHostClient(opts)`. */
  createHostClient?: (
    opts: SpaceHostClientOptions,
  ) => Pick<SpaceHostClient, 'listRepoOps' | 'getRecord'>
  /** Byte cap on a decoded record's JSON size, whether it arrived inline or via `getRecord`. */
  maxRecordBytes?: number
  maxPages?: number
  maxRecordsPerMember?: number
  /** Injectable clock for tests. Returns an ISO-8601 timestamp. */
  now?: () => string
  /** Structured per-target summary sink. Defaults to `console.log(JSON.stringify(...))`. */
  log?: (event: SpaceSyncLogEvent) => void
  /** Called once per failed target. Defaults to `console.error`. */
  onError?: (target: PollTarget, err: unknown) => void
}

export interface SpaceSyncSuccess {
  readonly target: PollTarget
  readonly ok: true
  readonly pagesFetched: number
  readonly recordsIndexed: number
  readonly recordsDeleted: number
  readonly skippedOversized: number
  readonly skippedMalformed: number
  readonly stopReason: 'complete' | 'max-pages' | 'per-member-cap'
  /** Opaque signed-commit envelope from the terminal page. Verified in WP5. */
  readonly finalCommit?: Record<string, unknown>
}

export interface SpaceSyncFailure {
  readonly target: PollTarget
  readonly ok: false
  /**
   * `'malformed-cursor'`: the host rejected the stored cursor; it has been
   * dropped so the next pass starts that (space, member) pair cold.
   * `'member-skip'`: any other failure (unreachable host, missing repo,
   * timeout, oversized page, invalid response). The stored cursor is left
   * untouched.
   */
  readonly reason: 'malformed-cursor' | 'member-skip'
  readonly error: unknown
}

export type SpaceSyncResult = SpaceSyncSuccess | SpaceSyncFailure

export interface SpaceSyncLogEvent {
  spaceUri: string
  did: string
  pagesFetched: number
  recordsIndexed: number
  recordsDeleted: number
  skippedOversized: number
  skippedMalformed: number
  stopReason: 'complete' | 'max-pages' | 'per-member-cap'
}

interface AppliedPage {
  indexed: number
  deleted: number
  skippedOversized: number
  skippedMalformed: number
}

/**
 * Polls one `pds`-custody member's repo for `zone.stratos.feed.post` ops and
 * applies them to the local index.
 *
 * Boundary is never read from the record or from `extractBoundaries` here —
 * a repo host does not authorize writes against the space authority, so a
 * boundary claimed on a `pds`-custody record is a user-supplied claim. Every
 * record this syncer indexes is stamped with `target.boundary`, the boundary
 * Stratos enrollment already attached to this poll target.
 */
export class SpaceSyncer {
  private readonly store: SpaceSyncerDeps['store']
  private readonly credentialManager: SpaceSyncerDeps['credentialManager']
  private readonly createHostClient: (
    opts: SpaceHostClientOptions,
  ) => Pick<SpaceHostClient, 'listRepoOps' | 'getRecord'>
  private readonly maxRecordBytes: number
  private readonly maxPages: number
  private readonly maxRecordsPerMember: number
  private readonly now: () => string
  private readonly log: (event: SpaceSyncLogEvent) => void
  private readonly onError: (target: PollTarget, err: unknown) => void

  constructor(deps: SpaceSyncerDeps) {
    this.store = deps.store
    this.credentialManager = deps.credentialManager
    this.createHostClient =
      deps.createHostClient ?? ((opts) => new SpaceHostClient(opts))
    this.maxRecordBytes = deps.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES
    this.maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES
    this.maxRecordsPerMember =
      deps.maxRecordsPerMember ?? DEFAULT_MAX_RECORDS_PER_MEMBER
    this.now = deps.now ?? (() => new Date().toISOString())
    this.log = deps.log ?? defaultLog
    this.onError = deps.onError ?? defaultOnError
  }

  /**
   * Sync one poll target. Never throws — every failure resolves to a
   * `SpaceSyncFailure` so one bad target never blocks a caller iterating a
   * member list.
   */
  async syncTarget(target: PollTarget): Promise<SpaceSyncResult> {
    try {
      return await this.runSync(target)
    } catch (err) {
      if (err instanceof MalformedCursorError) {
        await this.store.deleteSpaceCursor(target.spaceUri, target.did)
        this.onError(target, err)
        return { target, ok: false, reason: 'malformed-cursor', error: err }
      }
      this.onError(target, err)
      return { target, ok: false, reason: 'member-skip', error: err }
    }
  }

  private async runSync(target: PollTarget): Promise<SpaceSyncSuccess> {
    const credential = await this.credentialManager.getCredential(
      target.boundary,
    )
    const client = this.createHostClient({
      hostOrigin: target.host,
      credentialProof: credential,
    })

    let cursor =
      (await this.store.getSpaceCursor(target.spaceUri, target.did)) ??
      undefined
    let pagesFetched = 0
    let recordsIndexed = 0
    let recordsDeleted = 0
    let skippedOversized = 0
    let skippedMalformed = 0
    let finalCommit: Record<string, unknown> | undefined
    let stopReason: SpaceSyncSuccess['stopReason']

    for (;;) {
      const page = await client.listRepoOps({
        space: target.spaceUri,
        repo: target.did,
        cursor,
      })
      pagesFetched += 1

      const applied = await this.applyPage(target, client, page.ops)
      recordsIndexed += applied.indexed
      recordsDeleted += applied.deleted
      skippedOversized += applied.skippedOversized
      skippedMalformed += applied.skippedMalformed

      const isTerminal = page.cursor === undefined
      if (page.cursor !== undefined) {
        await this.store.upsertSpaceCursor(
          target.spaceUri,
          target.did,
          page.cursor,
          this.now(),
        )
      } else if (page.commit) {
        finalCommit = page.commit
      }
      cursor = page.cursor

      if (isTerminal) {
        stopReason = 'complete'
        break
      }
      if (recordsIndexed >= this.maxRecordsPerMember) {
        stopReason = 'per-member-cap'
        break
      }
      if (pagesFetched >= this.maxPages) {
        stopReason = 'max-pages'
        break
      }
    }

    const result: SpaceSyncSuccess = {
      target,
      ok: true,
      pagesFetched,
      recordsIndexed,
      recordsDeleted,
      skippedOversized,
      skippedMalformed,
      stopReason,
      ...(finalCommit ? { finalCommit } : {}),
    }
    this.log({
      spaceUri: target.spaceUri,
      did: target.did,
      pagesFetched,
      recordsIndexed,
      recordsDeleted,
      skippedOversized,
      skippedMalformed,
      stopReason,
    })
    return result
  }

  /**
   * Applies one page's ops. Ops are validated, narrowed to
   * `zone.stratos.feed.post`, and coalesced to the last op per
   * `(collection, rkey)` before any `getRecord` fallback runs, so a
   * superseded op in the same page never costs a network call.
   */
  private async applyPage(
    target: PollTarget,
    client: Pick<SpaceHostClient, 'listRepoOps' | 'getRecord'>,
    ops: RepoOpEntry[],
  ): Promise<AppliedPage> {
    let skippedMalformed = 0
    const valid: RepoOpEntry[] = []
    for (const op of ops) {
      if (!isValidNsidStr(op.collection) || !isValidRkey(op.rkey)) {
        skippedMalformed += 1
        continue
      }
      valid.push(op)
    }

    const posts = valid.filter(
      (op) => op.collection === STRATOS_POST_COLLECTION,
    )
    const winners = selectLastOpPerPath(posts)

    let indexed = 0
    let deleted = 0
    let skippedOversized = 0
    for (const op of winners) {
      const uri = `${target.spaceUri}/${target.did}/${op.collection}/${op.rkey}`
      if (op.cid === null) {
        await this.store.deletePost(uri)
        deleted += 1
        continue
      }
      const cid = op.cid
      const value = await this.resolveValue(target, client, op)
      if (value === undefined) {
        skippedMalformed += 1
        continue
      }
      if (recordByteSize(value) > this.maxRecordBytes) {
        skippedOversized += 1
        continue
      }
      const nowIso = this.now()
      await this.store.upsertPost({
        uri,
        did: target.did,
        cid,
        sortAt: clampSortAt(pickSortAt(value, nowIso), nowIso),
        indexedAt: nowIso,
        record: value,
        blobRefs: extractBlobRefs(value),
        boundaries: [target.boundary],
      })
      indexed += 1
    }
    return { indexed, deleted, skippedOversized, skippedMalformed }
  }

  private async resolveValue(
    target: PollTarget,
    client: Pick<SpaceHostClient, 'listRepoOps' | 'getRecord'>,
    op: RepoOpEntry,
  ): Promise<Record<string, unknown> | undefined> {
    if (op.value !== undefined) {
      return isRecordValue(op.value) ? op.value : undefined
    }
    const fetched = await client.getRecord({
      space: target.spaceUri,
      repo: target.did,
      collection: op.collection,
      rkey: op.rkey,
    })
    return isRecordValue(fetched.value) ? fetched.value : undefined
  }
}

/** Keeps only the last op per `(collection, rkey)`, in the page's own order. */
function selectLastOpPerPath(ops: RepoOpEntry[]): RepoOpEntry[] {
  const byPath = new Map<string, RepoOpEntry>()
  for (const op of ops) {
    byPath.set(`${op.collection}/${op.rkey}`, op)
  }
  return [...byPath.values()]
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function recordByteSize(value: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/**
 * A future `createdAt` from an untrusted host must not pin a post to the top
 * of the feed. An unparseable value clamps the same way a future one does.
 */
function clampSortAt(sortAt: string, nowIso: string): string {
  const parsed = Date.parse(sortAt)
  const nowMs = Date.parse(nowIso)
  if (!Number.isFinite(parsed) || parsed > nowMs) return nowIso
  return sortAt
}

function defaultLog(event: SpaceSyncLogEvent): void {
  console.log(JSON.stringify({ msg: 'feedgen.space-sync-pass', ...event }))
}

function defaultOnError(target: PollTarget, err: unknown): void {
  console.error(
    `space sync failed for ${target.did} in ${target.spaceUri}:`,
    err,
  )
}
