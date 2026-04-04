import { FirehoseSubscription } from '@atcute/firehose'
import { fromBytes } from '@atcute/cbor'
import { ComAtprotoSyncSubscribeRepos } from '@atcute/atproto'
import { AtUri } from '@atproto/syntax'
import type { IndexingService } from '@atproto/bsky/dist/data-plane/server/indexing/index.js'
import type { HandleDedup } from '../util/handle-dedup.ts'
import {
  type BackgroundQueue,
  decodeCommitOps,
  ENROLLMENT_COLLECTION,
  jsonToLex,
  parseCid,
  parseEnrollmentRecord,
} from '@northskysocial/stratos-core'
import { fromUint8Array } from '@atcute/car'
import type { CursorManager } from '../storage/cursor-manager.ts'
import type { WorkerPool } from '../util/worker-pool.ts'
import { WriteOpAction } from '@atproto/repo'

type SubscribeReposMessage = ComAtprotoSyncSubscribeRepos.$message

export interface EnrollmentCallback {
  onEnrollmentDiscovered: (
    did: string,
    serviceUrl: string,
    boundaries: string[],
  ) => void
  onEnrollmentRemoved: (did: string) => void
}

interface CommitWork {
  type: 'commit'
  traceId: string
  message: Extract<
    SubscribeReposMessage,
    { $type: 'com.atproto.sync.subscribeRepos#commit' }
  >
}

interface IdentityWork {
  type: 'identity'
  traceId: string
  message: Extract<
    SubscribeReposMessage,
    { $type: 'com.atproto.sync.subscribeRepos#identity' }
  >
}

interface AccountWork {
  type: 'account'
  traceId: string
  message: Extract<
    SubscribeReposMessage,
    { $type: 'com.atproto.sync.subscribeRepos#account' }
  >
}

interface SyncWork {
  type: 'sync'
  traceId: string
  message: Extract<
    SubscribeReposMessage,
    { $type: 'com.atproto.sync.subscribeRepos#sync' }
  >
}

export type FirehoseWork = CommitWork | IdentityWork | AccountWork | SyncWork

export interface PdsFirehoseOptions {
  repoProvider: string
  cursorManager: CursorManager
  workerPool: WorkerPool<FirehoseWork>
  onWork: (work: FirehoseWork) => void
  onError?: (err: Error) => void
}

/**
 * PDS Firehose client for consuming real-time updates from a PDS (Personal Data Server).
 */
export class PdsFirehose {
  private subscription: FirehoseSubscription<
    typeof ComAtprotoSyncSubscribeRepos.mainSchema
  > | null = null
  private ws: WebSocket | null = null
  private running = false
  private abortController: AbortController | null = null

  constructor(private opts: PdsFirehoseOptions) {}

  /**
   * Check if the PDS firehose is currently connected.
   *
   * @returns {boolean} - True if the PDS firehose is connected, false otherwise.
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /**
   * Start consuming messages from the PDS firehose.
   */
  start(): void {
    this.running = true
    this.connect()
  }

  /**
   * Stop consuming messages from the PDS firehose.
   */
  stop(): void {
    this.running = false
    this.abortController?.abort()
    this.abortController = null
    this.subscription = null
  }

  /**
   * Connect to the PDS firehose and start consuming messages.
   * @private
   */
  private connect(): void {
    if (!this.running) return

    const cursorManager = this.opts.cursorManager

    this.subscription = new FirehoseSubscription({
      service: this.opts.repoProvider,
      nsid: ComAtprotoSyncSubscribeRepos.mainSchema,
      params: () => {
        const cursor = cursorManager.getPdsCursor()
        return cursor > 0 ? { cursor } : {}
      },
      validateMessages: false,
      onConnectionOpen: () => {
        console.log('pds firehose connected')
      },
      onConnectionClose: (event: { code: number; reason: string }) => {
        if (event.code !== 1000) {
          this.opts.onError?.(
            new Error(
              `pds firehose closed: code=${event.code} reason=${event.reason || 'none'}`,
            ),
          )
        }
      },
      onConnectionError: (event: Event) => {
        this.opts.onError?.(
          new Error(`pds firehose connection error: ${JSON.stringify(event)}`),
        )
      },
      onError: (error: string, message?: string) => {
        this.opts.onError?.(
          new Error(`pds firehose stream error: ${error}: ${message ?? ''}`),
        )
      },
    })

    this.consumeMessages()
  }

  /**
   * Consume messages from the PDS firehose.
   * @private
   */
  private consumeMessages(): void {
    if (!this.subscription || !this.running) return

    this.abortController = new AbortController()

    void (async () => {
      try {
        this.ws = (this.subscription as { socket?: WebSocket }).socket ?? null
        for await (const message of this.subscription!) {
          if (!this.running) break

          const work = this.classifyMessage(message)
          if (!work) continue

          // Non-blocking: drop messages when queue is full to prevent
          // unbounded memory growth in the firehose's internal buffer.
          // Cursor tracking allows resumption on reconnect.
          this.opts.workerPool.trySubmit(work)

          // Always advance cursor so reconnects resume from latest position
          if ('seq' in message && typeof message.seq === 'number') {
            this.opts.cursorManager.updatePdsCursor(message.seq)
          }
        }
      } catch (err) {
        if (this.running) {
          this.opts.onError?.(
            new Error(
              `pds firehose consumption error: ${err instanceof Error ? err.message : String(err)}`,
            ),
          )
        }
      }
    })()
  }

  /**
   * Classify a message from the PDS firehose into a FirehoseWork object.
   * @private
   * @param {SubscribeReposMessage} message - The message to classify.
   * @returns {FirehoseWork | null} - The classified work or null if the message type is unknown.
   */
  private classifyMessage(message: SubscribeReposMessage): FirehoseWork | null {
    const traceId = Math.random().toString(36).substring(2, 15)
    switch (message.$type) {
      case 'com.atproto.sync.subscribeRepos#commit':
        return { type: 'commit', message, traceId }
      case 'com.atproto.sync.subscribeRepos#identity':
        return { type: 'identity', message, traceId }
      case 'com.atproto.sync.subscribeRepos#account':
        return { type: 'account', message, traceId }
      case 'com.atproto.sync.subscribeRepos#sync':
        return { type: 'sync', message, traceId }
      default:
        return null
    }
  }
}

/**
 * Process a FirehoseWork object by handling different types of messages.
 * @async
 * @param {FirehoseWork} work - The work to process.
 * @param {IndexingService} indexingService - The indexing service to use.
 * @param {BackgroundQueue} background - The background queue for processing.
 * @param {EnrollmentCallback} enrollmentCallback - The callback for enrollment.
 * @param {HandleDedup} handleDedup - The deduplication handler.
 * @returns {Promise<void>} - A promise that resolves when the work is processed.
 */
export async function processFirehoseWork(
  work: FirehoseWork,
  indexingService: IndexingService,
  background: BackgroundQueue,
  enrollmentCallback: EnrollmentCallback,
  handleDedup: HandleDedup,
): Promise<void> {
  const { traceId } = work
  switch (work.type) {
    case 'commit':
      await processCommit(
        work.message,
        indexingService,
        background,
        enrollmentCallback,
        handleDedup,
        traceId,
      )
      break
    case 'identity':
      await indexingService.indexHandle(
        work.message.did,
        work.message.time,
        true,
      )
      break
    case 'account':
      await processAccount(work.message, indexingService)
      break
    case 'sync':
      await processSync(work.message, indexingService)
      break
  }
}

/**
 * Process a commit message from the PDS firehose.
 * @param message - The commit message.
 * @param indexingService - The indexing service.
 * @param background - The background queue for processing.
 * @param enrollmentCallback - The callback for enrollment.
 * @param handleDedup - The deduplication handler.
 * @param traceId - The trace identifier for logging.
 */
async function processCommit(
  message: CommitWork['message'],
  indexingService: IndexingService,
  background: BackgroundQueue,
  enrollmentCallback: EnrollmentCallback,
  handleDedup: HandleDedup,
  traceId: string,
): Promise<void> {
  const did = message.repo
  const timestamp = message.time
  const commitCid = message.commit
  const rev = message.rev
  const rawBlocks = message.blocks
  const rawOps = message.ops

  if (handleDedup.shouldIndex(did)) {
    background.add(`indexHandle-${did}`, async () => {
      await indexingService.indexHandle(did, timestamp)
    })
  }

  console.log({ did, traceId }, 'processing firehose commit')
  await indexingService.setCommitLastSeen(did, parseCid(commitCid), rev)

  const blocks = fromBytes(rawBlocks)
  if (!blocks?.length) return

  const ops = decodeCommitOps(blocks, rawOps)

  for (const op of ops) {
    const uri = AtUri.make(did, op.collection, op.rkey)

    if (op.action === 'delete') {
      await indexingService.deleteRecord(uri)
      checkEnrollmentOp(did, op, enrollmentCallback)
      continue
    }

    if (!op.record || !op.cid) continue

    await indexingService.indexRecord(
      uri,
      parseCid(op.cid),
      jsonToLex(op.record),
      op.action === 'create' ? WriteOpAction.Create : WriteOpAction.Update,
      message.time,
    )

    checkEnrollmentOp(did, op, enrollmentCallback)
  }
}

/**
 * Check if an operation is related to enrollment and trigger enrollment callback.
 * @param did - The DID of the actor.
 * @param op - The operation details.
 * @param enrollmentCallback - The callback for enrollment.
 */
function checkEnrollmentOp(
  did: string,
  op: {
    action: string
    collection: string
    rkey: string
    record?: Record<string, unknown>
  },
  enrollmentCallback: EnrollmentCallback,
): void {
  if (op.collection !== ENROLLMENT_COLLECTION) return

  if (op.action === 'create' || op.action === 'update') {
    if (!op.record) return
    const enrollment = parseEnrollmentRecord(op.record, op.rkey)
    if (enrollment) {
      enrollmentCallback.onEnrollmentDiscovered(
        did,
        enrollment.service,
        enrollment.boundaries.map((b) => b.value),
      )
    }
  } else if (op.action === 'delete') {
    enrollmentCallback.onEnrollmentRemoved(did)
  }
}

/**
 * Process an account message from the PDS firehose.
 * @async
 * @param message - The account message.
 * @param indexingService - The indexing service.
 * @returns {Promise<void>} - A promise that resolves when the account message is processed.
 */
async function processAccount(
  message: AccountWork['message'],
  indexingService: IndexingService,
): Promise<void> {
  if (!message.active && message.status === 'deleted') {
    await indexingService.deleteActor(message.did)
  } else {
    await indexingService.updateActorStatus(
      message.did,
      message.active,
      message.status,
    )
  }
}

/**
 * Process a sync message from the PDS firehose.
 *
 * @param message - The sync message.
 * @param indexingService - The indexing service.
 */
async function processSync(
  message: SyncWork['message'],
  indexingService: IndexingService,
): Promise<void> {
  const { did, rev, time: timestamp, blocks: rawBlocks } = message
  const blocks = fromBytes(rawBlocks)
  const cid = parseCid(fromUint8Array(blocks).header.data.roots[0])
  await Promise.all([
    indexingService.setCommitLastSeen(did, cid, rev),
    indexingService.indexHandle(did, timestamp),
  ])
}
