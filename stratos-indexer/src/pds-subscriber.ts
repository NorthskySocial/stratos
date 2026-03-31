import {
  type EnrollmentCallback,
  PdsFirehose,
  processFirehoseWork,
} from './pds-firehose.js'
import type { IndexingService } from '@atproto/bsky/dist/data-plane/server/indexing/index.js'
import { WorkerPool } from './worker-pool.js'
import { HandleDedup } from './handle-dedup.js'
import { BackgroundQueue } from '@northskysocial/stratos-core'

export interface PdsSubscriberOptions {
  repoProvider: string
  indexingService: IndexingService
  background: BackgroundQueue
  enrollmentCallback: EnrollmentCallback
  handleDedup: HandleDedup
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
  private workerPool: WorkerPool

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
    this.workerPool = new WorkerPool(
      opts.concurrency,
      opts.maxQueueSize,
      async (work: unknown) => {
        await processFirehoseWork(
          work as Parameters<typeof processFirehoseWork>[0],
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
      onWork: (work) => this.workerPool.add(work),
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
    this.workerPool.stop()
  }

  /**
   * Check if the PDS subscriber is connected to the firehose.
   * @returns true if the firehose is connected, false otherwise.
   */
  isConnected(): boolean {
    return this.firehose.isConnected()
  }
}
