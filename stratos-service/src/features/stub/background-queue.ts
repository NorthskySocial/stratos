import { CID } from 'multiformats/cid'
import type {
  StubWriterService,
  Logger,
} from '@northskysocial/stratos-core'

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

export class BackgroundStubQueue {
  private pending = 0
  private queue: StubOp[] = []
  private processing = false

  constructor(
    private stubWriter: StubWriterService,
    private logger?: Logger,
  ) {}

  enqueueWrite(
    did: string,
    collection: string,
    rkey: string,
    recordType: string,
    fullRecordCid: CID,
    createdAt: string,
  ): void {
    this.queue.push({
      type: 'write',
      did,
      collection,
      rkey,
      recordType,
      fullRecordCid,
      createdAt,
    })
    this.processNext()
  }

  enqueueDelete(did: string, collection: string, rkey: string): void {
    this.queue.push({ type: 'delete', did, collection, rkey })
    this.processNext()
  }

  get pendingCount(): number {
    return this.pending + this.queue.length
  }

  async drain(): Promise<void> {
    while (this.pendingCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

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
