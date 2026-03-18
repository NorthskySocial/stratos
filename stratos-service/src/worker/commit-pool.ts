import { Worker, MessageChannel } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  type ReadonlyBlockStore,
  type MstWriteInput,
  type UnsignedCommitData,
  type MstBlockMap,
} from '@northskysocial/stratos-core'

const WORKER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'commit-worker.js',
)

interface PendingTask {
  resolve: (result: UnsignedCommitData) => void
  reject: (error: Error) => void
  port: import('node:worker_threads').MessagePort
}

interface QueuedTask {
  blockStore: ReadonlyBlockStore
  commitCid: string | null
  input: MstWriteInput
  resolve: (result: UnsignedCommitData) => void
  reject: (error: Error) => void
}

interface WorkerState {
  worker: Worker
  busy: boolean
}

export class CommitPool {
  private workers: WorkerState[] = []
  private taskQueue: QueuedTask[] = []
  private pendingTasks = new Map<string, PendingTask>()
  private roundRobin = 0
  private nextTaskId = 0
  private destroyed = false

  constructor(poolSize: number) {
    for (let i = 0; i < poolSize; i++) {
      const worker = new Worker(WORKER_PATH)
      worker.on('message', (msg) => this.handleWorkerMessage(worker, msg))
      worker.on('error', (err: Error) => this.handleWorkerError(worker, err))
      this.workers.push({ worker, busy: false })
    }
  }

  async buildCommit(
    blockStore: ReadonlyBlockStore,
    commitCid: string | null,
    input: MstWriteInput,
  ): Promise<UnsignedCommitData> {
    if (this.destroyed) {
      throw new Error('CommitPool is destroyed')
    }

    const available = this.workers.find((w) => !w.busy)
    if (available) {
      return this.dispatch(available, blockStore, commitCid, input)
    }

    return new Promise((resolve, reject) => {
      this.taskQueue.push({ blockStore, commitCid, input, resolve, reject })
    })
  }

  private dispatch(
    workerState: WorkerState,
    blockStore: ReadonlyBlockStore,
    commitCid: string | null,
    input: MstWriteInput,
  ): Promise<UnsignedCommitData> {
    const taskId = String(this.nextTaskId++)
    const { port1, port2 } = new MessageChannel()

    workerState.busy = true

    port1.on('message', async (msg: { type: string; requestId: number; cid?: string; cids?: string[] }) => {
      try {
        switch (msg.type) {
          case 'get': {
            const data = await blockStore.get(msg.cid!)
            port1.postMessage(
              { requestId: msg.requestId, data },
              data ? [data.buffer] : [],
            )
            break
          }
          case 'getMany': {
            const result = await blockStore.getMany(msg.cids!)
            const found: [string, Uint8Array][] = Array.from(
              result.found.entries(),
            )
            const transferables = found.map(([, v]) => v.buffer)
            port1.postMessage(
              { requestId: msg.requestId, found, missing: result.missing },
              transferables,
            )
            break
          }
          case 'has': {
            const result = await blockStore.has(msg.cid!)
            port1.postMessage({ requestId: msg.requestId, result })
            break
          }
        }
      } catch (err) {
        port1.postMessage({
          requestId: msg.requestId,
          data: null,
          missing: msg.cids ?? [],
          result: false,
        })
      }
    })

    return new Promise((resolve, reject) => {
      this.pendingTasks.set(taskId, { resolve, reject, port: port1 })

      workerState.worker.postMessage(
        { type: 'buildCommit', taskId, commitCid, input, port: port2 },
        [port2],
      )
    })
  }

  private handleWorkerMessage(
    worker: Worker,
    msg: { type: string; taskId: string; result?: unknown; error?: string },
  ): void {
    if (msg.type === 'commitResult') {
      const task = this.pendingTasks.get(msg.taskId)
      if (task) {
        this.pendingTasks.delete(msg.taskId)
        task.port.close()
        const raw = msg.result as {
          did: string
          version: 3
          data: string
          rev: string
          prev: null
          newBlocks: [string, Uint8Array][]
          removedCids: string[]
        }
        const newBlocks: MstBlockMap = new Map(
          raw.newBlocks.map(([k, v]) => [k, v as Uint8Array<ArrayBuffer>]),
        )
        task.resolve({
          did: raw.did,
          version: raw.version,
          data: raw.data,
          rev: raw.rev,
          prev: raw.prev,
          newBlocks,
          removedCids: raw.removedCids,
        })
      }
      this.markWorkerAvailable(worker)
    } else if (msg.type === 'commitError') {
      const task = this.pendingTasks.get(msg.taskId)
      if (task) {
        this.pendingTasks.delete(msg.taskId)
        task.port.close()
        task.reject(new Error(msg.error ?? 'Worker commit failed'))
      }
      this.markWorkerAvailable(worker)
    }
  }

  private handleWorkerError(worker: Worker, err: Error): void {
    // Reject all pending tasks for this worker
    for (const [taskId, task] of this.pendingTasks) {
      task.port.close()
      task.reject(err instanceof Error ? err : new Error(String(err)))
      this.pendingTasks.delete(taskId)
    }
    this.markWorkerAvailable(worker)
  }

  private markWorkerAvailable(worker: Worker): void {
    const ws = this.workers.find((w) => w.worker === worker)
    if (!ws) return
    ws.busy = false

    // Process next task from queue
    if (this.taskQueue.length > 0) {
      const next = this.taskQueue.shift()!
      this.dispatch(ws, next.blockStore, next.commitCid, next.input).then(
        next.resolve,
        next.reject,
      )
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true

    // Reject queued tasks
    for (const queued of this.taskQueue) {
      queued.reject(new Error('CommitPool is being destroyed'))
    }
    this.taskQueue = []

    // Terminate all workers
    await Promise.all(this.workers.map((w) => w.worker.terminate()))
    this.workers = []
  }
}
