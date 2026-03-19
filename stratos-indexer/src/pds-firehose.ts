import { FirehoseSubscription } from '@atcute/firehose'
import { fromUint8Array } from '@atcute/car'
import { fromBytes } from '@atcute/cbor'
import { ComAtprotoSyncSubscribeRepos } from '@atcute/atproto'
import type { WriteOpAction } from '@atproto/repo'
import { AtUri } from '@atproto/syntax'
import type { IndexingService } from '@atproto/bsky/dist/data-plane/server/indexing/index.js'
import type { BackgroundQueue } from '@atproto/bsky'
import type { WorkerPool } from './worker-pool.ts'
import type { CursorManager } from './cursor-manager.ts'
import type { HandleDedup } from './handle-dedup.ts'
import {
  decodeCommitOps,
  parseCid,
  jsonToLex,
  extractBoundaries,
} from './record-decoder.ts'

const ENROLLMENT_COLLECTION = 'zone.stratos.actor.enrollment'

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
  message: Extract<
    SubscribeReposMessage,
    { $type: 'com.atproto.sync.subscribeRepos#commit' }
  >
}

interface IdentityWork {
  type: 'identity'
  message: Extract<
    SubscribeReposMessage,
    { $type: 'com.atproto.sync.subscribeRepos#identity' }
  >
}

interface AccountWork {
  type: 'account'
  message: Extract<
    SubscribeReposMessage,
    { $type: 'com.atproto.sync.subscribeRepos#account' }
  >
}

interface SyncWork {
  type: 'sync'
  message: Extract<
    SubscribeReposMessage,
    { $type: 'com.atproto.sync.subscribeRepos#sync' }
  >
}

type FirehoseWork = CommitWork | IdentityWork | AccountWork | SyncWork

export interface PdsFirehoseOptions {
  repoProvider: string
  indexingService: IndexingService
  background: BackgroundQueue
  workerPool: WorkerPool<FirehoseWork>
  cursorManager: CursorManager
  enrollmentCallback: EnrollmentCallback
  handleDedup: HandleDedup
  onError?: (err: Error) => void
}

export class PdsFirehose {
  private subscription: FirehoseSubscription<
    typeof ComAtprotoSyncSubscribeRepos.mainSchema
  > | null = null
  private running = false
  private abortController: AbortController | null = null

  constructor(private opts: PdsFirehoseOptions) {}

  start(): void {
    this.running = true
    this.connect()
  }

  stop(): void {
    this.running = false
    this.abortController?.abort()
    this.abortController = null
    this.subscription = null
  }

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
          new Error('pds firehose connection error', { cause: event }),
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

  private consumeMessages(): void {
    if (!this.subscription || !this.running) return

    this.abortController = new AbortController()

    void (async () => {
      try {
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
            new Error('pds firehose consumption error', { cause: err }),
          )
        }
      }
    })()
  }

  private classifyMessage(message: SubscribeReposMessage): FirehoseWork | null {
    switch (message.$type) {
      case 'com.atproto.sync.subscribeRepos#commit':
        return { type: 'commit', message }
      case 'com.atproto.sync.subscribeRepos#identity':
        return { type: 'identity', message }
      case 'com.atproto.sync.subscribeRepos#account':
        return { type: 'account', message }
      case 'com.atproto.sync.subscribeRepos#sync':
        return { type: 'sync', message }
      default:
        return null
    }
  }
}

export async function processFirehoseWork(
  work: FirehoseWork,
  indexingService: IndexingService,
  background: BackgroundQueue,
  enrollmentCallback: EnrollmentCallback,
  handleDedup: HandleDedup,
): Promise<void> {
  switch (work.type) {
    case 'commit':
      await processCommit(
        work.message,
        indexingService,
        background,
        enrollmentCallback,
        handleDedup,
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

async function processCommit(
  message: CommitWork['message'],
  indexingService: IndexingService,
  background: BackgroundQueue,
  enrollmentCallback: EnrollmentCallback,
  handleDedup: HandleDedup,
): Promise<void> {
  const did = message.repo
  const timestamp = message.time
  const commitCid = message.commit
  const rev = message.rev
  const rawBlocks = message.blocks
  const rawOps = message.ops

  if (handleDedup.shouldIndex(did)) {
    background.add(() => indexingService.indexHandle(did, timestamp))
  }

  await indexingService.setCommitLastSeen(
    did,
    parseCid(commitCid),
    rev,
  )

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
      op.action === 'create'
        ? ('create' as WriteOpAction)
        : ('update' as WriteOpAction),
      message.time,
    )

    checkEnrollmentOp(did, op, enrollmentCallback)
  }
}

function checkEnrollmentOp(
  did: string,
  op: { action: string; collection: string; record?: Record<string, unknown> },
  enrollmentCallback: EnrollmentCallback,
): void {
  if (op.collection !== ENROLLMENT_COLLECTION) return

  if (op.action === 'create' || op.action === 'update') {
    if (!op.record) return
    const serviceUrl =
      typeof op.record.service === 'string' ? op.record.service : ''
    const boundaries = extractBoundaries(op.record)
    if (serviceUrl) {
      enrollmentCallback.onEnrollmentDiscovered(did, serviceUrl, boundaries)
    }
  } else if (op.action === 'delete') {
    enrollmentCallback.onEnrollmentRemoved(did)
  }
}

async function processAccount(
  message: AccountWork['message'],
  indexingService: IndexingService,
): Promise<void> {
  if (message.active === false && message.status === 'deleted') {
    await indexingService.deleteActor(message.did)
  } else {
    await indexingService.updateActorStatus(
      message.did,
      message.active,
      message.status,
    )
  }
}

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
