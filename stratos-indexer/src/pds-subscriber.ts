import {
  type EnrollmentCallback,
  type FirehoseWork,
  PdsFirehose,
  processFirehoseWork,
} from './pds-firehose.js'
import type { IndexingService } from '@atproto/bsky/dist/data-plane/server/indexing/index.js'
import type { CursorManager } from './cursor-manager.js'
import { BackgroundQueue } from '@northskysocial/stratos-core'
import { HandleDedup } from './handle-dedup.ts'
import { WorkerPool } from './worker-pool.ts'

export interface PdsSubscriberOptions {
  repoProvider: string
  indexingService: IndexingService
  background: BackgroundQueue
  enrollmentCallback: EnrollmentCallback
  handleDedup: HandleDedup
  cursorManager: CursorManager
  concurrency: number
  maxQueueSize: number
  onError?: (err: Error) => void
}

/**
 * A PDS subscriber that processes firehose events and enrolls handles.
 * @class
 */
export class PdsSubscriber {
  private firehose: PdsFirehose
  private readonly workerPool: WorkerPool<FirehoseWork>

  /**
   * Create a new PDS subscriber with the given options.
   * @param opts - The options for the PDS subscriber.
   * @param opts.repoProvider - The provider URL for the repository.
   * @param opts.indexingService - The indexing service instance.
   * @param opts.background - The background queue instance.
   * @param opts.enrollmentCallback - The enrollment callback instance.
   * @param opts.handleDedup - The handle deduplication instance.
   * @param opts.concurrency - The number of concurrent worker threads.
   * @param opts.maxQueueSize - The maximum size of the work queue.
   * @param opts.onError - The error handler function.
   * @returns A new PDS subscriber instance.
   */
  constructor(opts: PdsSubscriberOptions) {
    this.workerPool = new WorkerPool<FirehoseWork>(
      opts.concurrency,
      opts.maxQueueSize,
      async (work) => {
        await processFirehoseWork(
          work,
          opts.indexingService,
          opts.background,
          opts.enrollmentCallback,
          opts.handleDedup,
        )
      },
      (err) => {
        if (opts.onError) {
          opts.onError(err)
        } else {
          console.error(
            { err: err.message },
            'PDS Subscriber worker pool error',
          )
        }
      },
    )

    this.firehose = new PdsFirehose({
      repoProvider: opts.repoProvider,
      cursorManager: opts.cursorManager,
      workerPool: this.workerPool,
      onWork: (work) => {
        void this.workerPool.submit(work)
      },
      onError: (err) => {
        if (opts.onError) {
          opts.onError(err)
        } else {
          console.error({ err: err.message }, 'PDS Subscriber firehose error')
        }
      },
    })
  }

  /**
   * Get the current status of the PDS subscriber.
   * @returns An object containing the current status of the PDS subscriber.
   * @property {number} pendingCount - The number of pending work items in the worker pool.
   * @property {number} runningCount - The number of running work items in the worker pool.
   */
  get stats() {
    return {
      pendingCount: this.workerPool.pendingCount,
      runningCount: this.workerPool.runningCount,
    }
  }

  /**
   * Start the PDS subscriber by connecting to the firehose and worker pool.
   */
  start() {
    this.firehose.start()
  }

  /**
   * Stop the PDS subscriber by disconnecting from the firehose and worker pool.
   */
  stop() {
    this.firehose.stop()
    void this.workerPool.stop()
  }

  /**
   * Check if the PDS subscriber is connected to the firehose.
   * @returns true if the firehose is connected, false otherwise.
   */
  isConnected(): boolean {
    return this.firehose.isConnected()
  }
}
