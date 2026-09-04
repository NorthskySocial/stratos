import { extractBoundaries } from '@northskysocial/stratos-core'
import type { BlobRef, FeedgenStore } from '../db/index.js'
import type { ReplayAuthorizer } from './replay-authorizer.js'

export const STRATOS_POST_COLLECTION = 'zone.stratos.feed.post'

export interface CommitOp {
  action: 'create' | 'update' | 'delete'
  path: string
  cid?: string
  record?: Record<string, unknown>
}

export interface IndexCommitArgs {
  did: string
  seq: number
  time: string
  ops: CommitOp[]
}

/**
 * Thin SQLite writer that takes decoded commit ops from `ActorSyncer` and
 * persists `zone.stratos.feed.post` records via the feedgen store. Skips
 * records in any other collection.
 */
export interface SubscriptionIndexerHooks {
  /** Observability hook fired after a local projection write. */
  onPostIndexed?: (operation: 'upsert' | 'delete') => void
}

export interface SubscriptionIndexerOptions extends SubscriptionIndexerHooks {
  /**
   * Optional while older callers are migrated. When present, replayed post
   * boundaries are narrowed to the actor's current authorization before
   * persistence.
   */
  replayAuthorizer?: ReplayAuthorizer
}

export class SubscriptionIndexer {
  private readonly hooks: SubscriptionIndexerHooks
  private readonly replayAuthorizer?: ReplayAuthorizer

  constructor(
    private store: FeedgenStore,
    options: SubscriptionIndexerOptions = {},
  ) {
    this.hooks = options
    this.replayAuthorizer = options.replayAuthorizer
  }

  /**
   * Apply a single decoded commit to the store. All ops belonging to the
   * commit are processed before the cursor is advanced so a crash mid-commit
   * leaves the cursor at the prior `seq` and replay is idempotent.
   */
  async applyCommit(args: IndexCommitArgs): Promise<void> {
    const { did, seq, time, ops } = args
    for (const op of ops) {
      // Accept both `${collection}/${rkey}` and `/${collection}/${rkey}`:
      // older sequence events were written with a leading slash.
      const path = op.path.startsWith('/') ? op.path.slice(1) : op.path
      if (!isPostPath(path)) continue
      if (op.action === 'delete') {
        await this.store.deletePost(`at://${did}/${path}`)
        this.hooks.onPostIndexed?.('delete')
        continue
      }
      if (!op.cid || !op.record) continue
      if (op.record['$type'] !== STRATOS_POST_COLLECTION) continue
      const uri = `at://${did}/${path}`
      const sortAt = pickSortAt(op.record, time)
      const recordBoundaries = extractBoundaries(op.record)
      const boundaries = this.replayAuthorizer
        ? await this.replayAuthorizer.authorize(did, recordBoundaries)
        : recordBoundaries
      // An authorizer's empty result is a current-authority denial. Deleting
      // any historical copy makes replay fail closed; the commit can then
      // advance without reintroducing the forbidden record.
      if (this.replayAuthorizer && boundaries.length === 0) {
        await this.store.deletePost(uri)
        this.hooks.onPostIndexed?.('delete')
        continue
      }
      const blobRefs = extractBlobRefs(op.record)
      await this.store.upsertPost({
        uri,
        did,
        cid: op.cid,
        sortAt,
        indexedAt: time,
        record: op.record,
        blobRefs,
        boundaries,
      })
      this.hooks.onPostIndexed?.('upsert')
    }
    await this.store.upsertCursor(did, seq, time)
  }
}

function isPostPath(path: string): boolean {
  return path.startsWith(`${STRATOS_POST_COLLECTION}/`)
}

export function pickSortAt(
  record: Record<string, unknown>,
  fallback: string,
): string {
  const createdAt = record['createdAt']
  return typeof createdAt === 'string' && createdAt.length > 0
    ? createdAt
    : fallback
}

/**
 * Best-effort extraction of blob refs from common embed shapes:
 * `app.bsky.embed.images`, `app.bsky.embed.video`, `app.bsky.embed.external`,
 * and the `recordWithMedia` variant. Returns an empty array if the record
 * carries no embed.
 */
export function extractBlobRefs(record: Record<string, unknown>): BlobRef[] {
  const refs: BlobRef[] = []
  const seen = new Set<string>()
  const push = (cid: string, mimeType?: string): void => {
    if (seen.has(cid)) return
    seen.add(cid)
    refs.push(mimeType ? { cid, mimeType } : { cid })
  }
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    const obj = value as Record<string, unknown>
    const ref = obj['ref']
    if (ref && typeof ref === 'object') {
      const link = (ref as Record<string, unknown>)['$link']
      if (typeof link === 'string') {
        const mime = obj['mimeType']
        push(link, typeof mime === 'string' ? mime : undefined)
      }
    }
    for (const key of Object.keys(obj)) {
      walk(obj[key])
    }
  }
  walk(record['embed'])
  return refs
}
