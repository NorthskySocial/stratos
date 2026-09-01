import {
  isValidNsidStr,
  isValidRkey,
  parseCid,
} from '@northskysocial/stratos-core'
import {
  DEFAULT_SPACE_SYNC_PAGE_LIMIT,
  DEFAULT_SPACE_SYNC_MAX_PAGES,
  DEFAULT_SPACE_SYNC_MAX_RECORD_BYTES,
  DEFAULT_SPACE_SYNC_MAX_RECORDS_PER_MEMBER,
} from '../config.js'
import type { FeedgenStore, SpaceSyncStageMutation } from '../db/index.js'
import {
  extractBlobRefs,
  pickSortAt,
  STRATOS_POST_COLLECTION,
} from '../subscription/index.js'
import type { SpaceCredentialManager } from '../space-credential/index.js'
import {
  getRepoOpsResponseByteLimit,
  SpaceHostClient,
  type RepoOpEntry,
  type SpaceHostClientOptions,
} from './host-client.js'
import {
  MalformedCursorError,
  SpaceHostInvalidResponseError,
} from './errors.js'
import type { PollTarget } from './membership.js'
import type { SpaceMutationFence } from '../mutation-fence.js'

export interface SpaceSyncerDeps {
  store: Pick<
    FeedgenStore,
    | 'getSpaceCursor'
    | 'stageSpaceSyncPage'
    | 'resetSpaceSyncState'
    | 'promoteSpaceSyncStage'
  >
  credentialManager: Pick<SpaceCredentialManager, 'getCredential'>
  mutationFence: Pick<SpaceMutationFence, 'mutate'>
  /** Injectable host-client factory (test seam). Defaults to `new SpaceHostClient(opts)`. */
  createHostClient?: (
    opts: SpaceHostClientOptions,
  ) => Pick<SpaceHostClient, 'listRepoOps' | 'getRecord'>
  /** Byte cap on a decoded record's JSON size, whether it arrived inline or via `getRecord`. */
  maxRecordBytes?: number
  maxPages?: number
  maxRecordsPerMember?: number
  /** Upper bound forwarded as `listRepoOps`'s `limit`. */
  pageLimit?: number
  /** Injectable clock for tests. Returns an ISO-8601 timestamp. */
  now?: () => string
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
   * dropped with its unverified page state so the next pass starts that
   * (space, member) pair cold. `'aborted'`: the caller's `signal` fired
   * before the sync reached a terminal or capped stopping point. Durable
   * staged pages remain unserved until a later terminal commit verifies.
   * `'member-skip'`: any other failure (unreachable host, missing repo,
   * timeout, oversized page, invalid response). The stored cursor is left
   * untouched.
   */
  readonly reason: 'malformed-cursor' | 'aborted' | 'member-skip'
  readonly error: unknown
}

export type SpaceSyncResult = SpaceSyncSuccess | SpaceSyncFailure

interface AppliedPage {
  indexed: number
  deleted: number
  skippedOversized: number
  skippedMalformed: number
  mutations: SpaceSyncStageMutation[]
}

/**
 * Polls one `pds`-custody member's repo for `zone.stratos.feed.post` ops and
 * stages them until a terminal commit proves the host's result.
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
  private readonly mutationFence: SpaceSyncerDeps['mutationFence']
  private readonly createHostClient: (
    opts: SpaceHostClientOptions,
  ) => Pick<SpaceHostClient, 'listRepoOps' | 'getRecord'>
  private readonly maxRecordBytes: number
  private readonly maxPages: number
  private readonly maxRecordsPerMember: number
  private readonly pageLimit: number
  private readonly now: () => string
  private readonly onError: (target: PollTarget, err: unknown) => void

  constructor(deps: SpaceSyncerDeps) {
    this.store = deps.store
    this.credentialManager = deps.credentialManager
    this.mutationFence = deps.mutationFence
    this.maxRecordBytes =
      deps.maxRecordBytes ?? DEFAULT_SPACE_SYNC_MAX_RECORD_BYTES
    this.maxPages = deps.maxPages ?? DEFAULT_SPACE_SYNC_MAX_PAGES
    this.maxRecordsPerMember =
      deps.maxRecordsPerMember ?? DEFAULT_SPACE_SYNC_MAX_RECORDS_PER_MEMBER
    this.pageLimit = deps.pageLimit ?? DEFAULT_SPACE_SYNC_PAGE_LIMIT
    this.createHostClient =
      deps.createHostClient ??
      ((opts) =>
        new SpaceHostClient({
          ...opts,
          maxPageBytes: getRepoOpsResponseByteLimit(
            this.pageLimit,
            this.maxRecordBytes,
          ),
          maxRecordBytes: this.maxRecordBytes,
        }))
    this.now = deps.now ?? (() => new Date().toISOString())
    this.onError = deps.onError ?? defaultOnError
  }

  /**
   * Sync one poll target. Never throws — every failure resolves to a
   * `SpaceSyncFailure` so one bad target never blocks a caller iterating a
   * member list.
   *
   * `signal`, when provided and already aborted or aborted mid-sync, cuts
   * the sync short at the next checkpoint. That is expected caller-driven
   * cancellation (e.g. a time budget), not a member fault, so it is neither
   * reported through `onError` nor treated like `'member-skip'`.
   */
  async syncTarget(
    target: PollTarget,
    signal?: AbortSignal,
  ): Promise<SpaceSyncResult> {
    try {
      return await this.runSync(target, signal)
    } catch (err) {
      if (signal?.aborted) {
        return { target, ok: false, reason: 'aborted', error: err }
      }
      if (err instanceof MalformedCursorError) {
        try {
          await this.mutationFence.mutate(target, signal, () =>
            this.store.resetSpaceSyncState(target.spaceUri, target.did),
          )
        } catch (mutationError) {
          if (signal?.aborted) {
            return {
              target,
              ok: false,
              reason: 'aborted',
              error: mutationError,
            }
          }
          this.onError(target, mutationError)
          return {
            target,
            ok: false,
            reason: 'member-skip',
            error: mutationError,
          }
        }
        this.onError(target, err)
        return { target, ok: false, reason: 'malformed-cursor', error: err }
      }
      if (err instanceof SpaceSyncAbortedError) {
        return { target, ok: false, reason: 'aborted', error: err }
      }
      this.onError(target, err)
      return { target, ok: false, reason: 'member-skip', error: err }
    }
  }

  private async runSync(
    target: PollTarget,
    signal?: AbortSignal,
  ): Promise<SpaceSyncSuccess> {
    const credential = await this.credentialManager.getCredential(
      target.boundary,
    )
    assertNotAborted(signal)
    const client = this.createHostClient({
      hostOrigin: target.host,
      credentialProof: credential,
    })

    let cursor =
      (await this.store.getSpaceCursor(target.spaceUri, target.did)) ??
      undefined
    assertNotAborted(signal)
    let pagesFetched = 0
    let recordsIndexed = 0
    let recordsDeleted = 0
    let skippedOversized = 0
    let skippedMalformed = 0
    let finalCommit: Record<string, unknown> | undefined
    let stopReason: SpaceSyncSuccess['stopReason']

    for (;;) {
      const remainingRecords = this.maxRecordsPerMember - recordsIndexed
      const requestLimit = Math.min(this.pageLimit, remainingRecords)
      const page = await client.listRepoOps({
        space: target.spaceUri,
        repo: target.did,
        cursor,
        limit: requestLimit,
        signal,
      })
      assertNotAborted(signal)
      if (page.ops.length > requestLimit) {
        throw new SpaceHostInvalidResponseError(
          target.host,
          `listRepoOps returned ${page.ops.length} ops for requested limit ${requestLimit}`,
        )
      }
      pagesFetched += 1

      const applied = await this.applyPage(target, client, page.ops, signal)
      assertNotAborted(signal)
      recordsIndexed += applied.indexed
      recordsDeleted += applied.deleted
      skippedOversized += applied.skippedOversized
      skippedMalformed += applied.skippedMalformed

      finalCommit = await this.persistPageProgress(
        target,
        applied.mutations,
        page.cursor,
        page.commit,
        signal,
      )
      assertNotAborted(signal)
      cursor = page.cursor

      if (page.cursor === undefined) {
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
    return result
  }

  private async persistPageProgress(
    target: PollTarget,
    mutations: readonly SpaceSyncStageMutation[],
    nextCursor: string | undefined,
    commit: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    await this.mutationFence.mutate(target, signal, () =>
      this.store.stageSpaceSyncPage({
        spaceUri: target.spaceUri,
        did: target.did,
        boundary: target.boundary,
        mutations,
        ...(nextCursor === undefined ? {} : { nextCursor }),
        updatedAt: this.now(),
      }),
    )
    return nextCursor === undefined ? commit : undefined
  }

  /** Called by the runner only after it verifies this target's terminal commit. */
  async promoteVerifiedStage(target: PollTarget): Promise<void> {
    await this.mutationFence.mutate(target, undefined, () =>
      this.store.promoteSpaceSyncStage(target.spaceUri, target.did),
    )
  }

  /**
   * Applies one page's ops. Ops are coalesced to the last op per
   * `(collection, rkey)`, then validated and narrowed to
   * `zone.stratos.feed.post` before any `getRecord` fallback runs, so an
   * invalid winner cannot reveal a superseded op from the same page.
   */
  private async applyPage(
    target: PollTarget,
    client: Pick<SpaceHostClient, 'listRepoOps' | 'getRecord'>,
    ops: RepoOpEntry[],
    signal?: AbortSignal,
  ): Promise<AppliedPage> {
    let skippedMalformed = 0
    const valid: RepoOpEntry[] = []
    for (const op of selectLastOpPerPath(ops)) {
      if (!isValidNsidStr(op.collection) || !isValidRkey(op.rkey)) {
        skippedMalformed += 1
        continue
      }
      if (op.cid === null) {
        valid.push(op)
        continue
      }
      try {
        valid.push({ ...op, cid: parseCid(op.cid).toString() })
      } catch {
        skippedMalformed += 1
      }
    }

    const posts = valid.filter(
      (op) => op.collection === STRATOS_POST_COLLECTION,
    )

    let indexed = 0
    let deleted = 0
    let skippedOversized = 0
    const mutations: SpaceSyncStageMutation[] = []
    for (const op of posts) {
      assertNotAborted(signal)
      const uri = `${target.spaceUri}/${target.did}/${op.collection}/${op.rkey}`
      if (op.cid === null) {
        mutations.push({ kind: 'delete', uri })
        deleted += 1
        continue
      }
      const cid = op.cid
      const value = await this.resolveValue(
        target,
        client,
        op,
        uri,
        cid,
        signal,
      )
      if (value === undefined) {
        skippedMalformed += 1
        continue
      }
      if (recordByteSize(value) > this.maxRecordBytes) {
        skippedOversized += 1
        continue
      }
      const nowIso = this.now()
      const post = {
        uri,
        did: target.did,
        cid,
        sortAt: clampSortAt(pickSortAt(value, nowIso), nowIso),
        indexedAt: nowIso,
        record: value,
        blobRefs: extractBlobRefs(value),
        boundaries: [target.boundary],
      }
      mutations.push({ kind: 'upsert', post })
      indexed += 1
    }
    return {
      indexed,
      deleted,
      skippedOversized,
      skippedMalformed,
      mutations,
    }
  }

  private async resolveValue(
    target: PollTarget,
    client: Pick<SpaceHostClient, 'listRepoOps' | 'getRecord'>,
    op: RepoOpEntry,
    expectedUri: string,
    expectedCid: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    if (op.value !== undefined) {
      return isPostRecordValue(op.value) ? op.value : undefined
    }
    const fetched = await client.getRecord({
      space: target.spaceUri,
      repo: target.did,
      collection: op.collection,
      rkey: op.rkey,
      signal,
    })
    if (fetched.uri !== expectedUri || fetched.cid !== expectedCid) {
      return undefined
    }
    return isPostRecordValue(fetched.value) ? fetched.value : undefined
  }
}

/**
 * Internal-only: marks a sync stopped cooperatively because `signal` fired.
 * Never crosses `syncTarget`'s boundary — caught there and turned into a
 * `SpaceSyncFailure` with reason `'aborted'`.
 */
class SpaceSyncAbortedError extends Error {}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SpaceSyncAbortedError()
}

/** Keeps only the last op per `(collection, rkey)`, in the page's own order. */
function selectLastOpPerPath(ops: RepoOpEntry[]): RepoOpEntry[] {
  const byPath = new Map<string, RepoOpEntry>()
  for (const op of ops) {
    byPath.set(`${op.collection}/${op.rkey}`, op)
  }
  return [...byPath.values()]
}

function isPostRecordValue(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)['$type'] === STRATOS_POST_COLLECTION
  )
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

function defaultOnError(target: PollTarget, err: unknown): void {
  console.error(
    `space sync failed for ${target.did} in ${target.spaceUri}:`,
    err,
  )
}
