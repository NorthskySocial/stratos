import { CID } from '@atproto/lex-data'
import type { Logger, StubWriterService } from '@northskysocial/stratos-core'

interface StubWriteOp {
  type: 'write'
  did: string
  collection: string
  rkey: string
  recordType: string
  fullRecordCid: CID
  createdAt: string
}

interface StubDeleteOp {
  type: 'delete'
  did: string
  collection: string
  rkey: string
}

type StubOp = StubWriteOp | StubDeleteOp

/**
 * Background queue for processing stub operations asynchronously.
 *
 * Provides methods to enqueue write and delete operations for stub records,
 * and processes them in the background. Ensures that operations are executed
 * in the order they were enqueued.
 */
export class BackgroundStubQueue {
  private pending = 0
  private queue: StubOp[] = []
  private processing = false

  constructor(
    private stubWriter: StubWriterService,
    private logger?: Logger,
  ) {}

  /**
   * Get the number of pending operations in the queue.
   *
   * @returns The number of pending operations.
   */
  get pendingCount(): number {
    return this.pending + this.queue.length
  }

  /**
   * Enqueue a write operation for a stub record.
   * @param did - The user's DID.
   * @param collection - The collection name for the stub record.
   * @param rkey - The record key for the stub record.
   * @param recordType - The type of the stub record.
   * @param fullRecordCid - The CID of the full record.
   * @param createdAt - The creation timestamp of the stub record.
   */
  enqueueWrite(
    did: string,
    collection: string,
    rkey: string,
    recordType: string,
    fullRecordCid: CID | string,
    createdAt: string,
  ): void {
    const cid =
      typeof fullRecordCid === 'string'
        ? CID.parse(fullRecordCid)
        : fullRecordCid
    this.queue.push({
      type: 'write',
      did,
      collection,
      rkey,
      recordType,
      fullRecordCid: cid,
      createdAt,
    })
    this.processNext()
  }

  /**
   * Enqueue a delete operation for a stub record.
   * @param did - The user's DID.
   * @param collection - The collection name for the stub record.
   * @param rkey - The record key for the stub record.
   */
  enqueueDelete(did: string, collection: string, rkey: string): void {
    this.queue.push({ type: 'delete', did, collection, rkey })
    this.processNext()
  }

  /**
   * Drain the queue by processing all pending operations.
   */
  async drain(): Promise<void> {
    while (this.pendingCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  /**
   * Stop the queue processing.
   */
  stop(): void {
    this.queue = []
    this.processing = false
  }

  /**
   * Process the next operation in the queue.
   */
  private processNext(): void {
    if (this.processing) return
    const op = this.queue.shift()
    if (!op) return

    this.processing = true
    this.pending++

    const promise =
      op.type === 'write'
        ? this.stubWriter.writeStub(
            op.did,
            op.collection,
            op.rkey,
            op.recordType,
            op.fullRecordCid,
            op.createdAt,
          )
        : this.stubWriter.deleteStub(op.did, op.collection, op.rkey)

    promise
      .catch((err) => {
        this.logger?.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            cause: err instanceof Error ? err.cause : undefined,
            did: op.did,
            collection: op.collection,
            rkey: op.rkey,
            stubOp: op.type,
          },
          `background stub ${op.type} failed`,
        )
      })
      .finally(() => {
        this.pending--
        this.processing = false
        this.processNext()
      })
  }
}
