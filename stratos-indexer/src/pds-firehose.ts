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

          // Backpressure: submit blocks until worker pool has space
          await this.opts.workerPool.submit(work)

          // Update cursor after successful submission
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
): Promise<void> {
  switch (work.type) {
    case 'commit':
      await processCommit(
        work.message,
        indexingService,
        background,
        enrollmentCallback,
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
): Promise<void> {
  const did = message.repo

  background.add(() => indexingService.indexHandle(did, message.time))

  await indexingService.setCommitLastSeen(
    did,
    parseCid(message.commit),
    message.rev,
  )

  const blocks = fromBytes(message.blocks)
  if (!blocks?.length) return

  const ops = decodeCommitOps(blocks, message.ops)

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
  const blocks = fromBytes(message.blocks)
  const cid = parseCid(fromUint8Array(blocks).header.data.roots[0])
  await Promise.all([
    indexingService.setCommitLastSeen(message.did, cid, message.rev),
    indexingService.indexHandle(message.did, message.time),
  ])
}
