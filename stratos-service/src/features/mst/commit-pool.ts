import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import type { BlockMap } from '@atcute/mst'
import type { MstWriteInput, UnsignedCommitData } from '@northskysocial/stratos-core'

interface PendingRequest {
  resolve: (value: UnsignedCommitData) => void
  reject: (reason: Error) => void
}

export class CommitPool {
  private workers: Worker[]
  private pending = new Map<number, PendingRequest>()
  private nextId = 0
  private nextWorker = 0

  constructor(poolSize?: number) {
    const size = poolSize ?? Math.min(4, Math.max(1, availableParallelism() - 1))
    const workerUrl = new URL('./commit-worker.js', import.meta.url)

    this.workers = Array.from({ length: size }, () => {
      const worker = new Worker(workerUrl)
      worker.on('message', (msg: { id: number; result?: unknown; error?: string }) => {
        const req = this.pending.get(msg.id)
        if (!req) return
        this.pending.delete(msg.id)

        if (msg.error) {
          req.reject(new Error(msg.error))
        } else {
          const r = msg.result as {
            did: string
            version: 3
            data: string
            rev: string
            prev: null
            newBlocks: [string, Uint8Array][]
            removedCids: string[]
          }
          req.resolve({
            did: r.did,
            version: r.version,
            data: r.data,
            rev: r.rev,
            prev: r.prev,
            newBlocks: new Map(
              r.newBlocks.map(([k, v]) => [k, new Uint8Array(v)] as [string, Uint8Array<ArrayBuffer>]),
            ) as BlockMap,
            removedCids: r.removedCids,
          })
        }
      })
      worker.on('error', (err) => {
        for (const [id, req] of this.pending) {
          req.reject(err instanceof Error ? err : new Error(String(err)))
          this.pending.delete(id)
        }
      })
      return worker
    })
  }

  async buildCommit(
    blocks: Map<string, Uint8Array>,
    currentCommitCid: string | null,
    input: MstWriteInput,
  ): Promise<UnsignedCommitData> {
    const id = this.nextId++
    const worker = this.workers[this.nextWorker % this.workers.length]
    this.nextWorker++

    return new Promise<UnsignedCommitData>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage({
        id,
        blocks: Array.from(blocks.entries()),
        currentCommitCid,
        input,
      })
    })
  }

  async destroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()))
    this.workers = []
    for (const [, req] of this.pending) {
      req.reject(new Error('CommitPool destroyed'))
    }
    this.pending.clear()
  }
}
