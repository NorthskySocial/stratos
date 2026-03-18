import { parentPort } from 'node:worker_threads'
import type { MessagePort } from 'node:worker_threads'
import {
  buildCommit,
  type ReadonlyBlockStore,
  type MstWriteInput,
  type MstBlockMap,
} from '@northskysocial/stratos-core'

interface BlockRequest {
  type: 'get' | 'getMany' | 'has'
  requestId: number
  cid?: string
  cids?: string[]
}

interface BlockResponse {
  requestId: number
  data?: Uint8Array | null
  found?: [string, Uint8Array][]
  missing?: string[]
  result?: boolean
}

interface BuildCommitTask {
  type: 'buildCommit'
  taskId: string
  commitCid: string | null
  input: MstWriteInput
  port: MessagePort
}

interface CommitResult {
  type: 'commitResult'
  taskId: string
  result: {
    did: string
    version: 3
    data: string
    rev: string
    prev: null
    newBlocks: [string, Uint8Array][]
    removedCids: string[]
  }
}

interface CommitError {
  type: 'commitError'
  taskId: string
  error: string
}

class ProxyBlockStore implements ReadonlyBlockStore {
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private nextId = 0

  constructor(private port: MessagePort) {
    port.on('message', (msg: BlockResponse) => {
      const p = this.pending.get(msg.requestId)
      if (p) {
        this.pending.delete(msg.requestId)
        p.resolve(msg)
      }
    })
  }

  async get(cid: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const requestId = this.nextId++
    const response = await new Promise<BlockResponse>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: resolve as (v: unknown) => void,
        reject,
      })
      this.port.postMessage({ type: 'get', requestId, cid } satisfies BlockRequest)
    })
    return (response.data ?? null) as Uint8Array<ArrayBuffer> | null
  }

  async getMany(
    cids: string[],
  ): Promise<{ found: MstBlockMap; missing: string[] }> {
    const requestId = this.nextId++
    const response = await new Promise<BlockResponse>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: resolve as (v: unknown) => void,
        reject,
      })
      this.port.postMessage({
        type: 'getMany',
        requestId,
        cids,
      } satisfies BlockRequest)
    })
    const found: MstBlockMap = new Map()
    if (response.found) {
      for (const [cid, bytes] of response.found) {
        found.set(cid, bytes as Uint8Array<ArrayBuffer>)
      }
    }
    return { found, missing: response.missing ?? [] }
  }

  async has(cid: string): Promise<boolean> {
    const requestId = this.nextId++
    const response = await new Promise<BlockResponse>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: resolve as (v: unknown) => void,
        reject,
      })
      this.port.postMessage({ type: 'has', requestId, cid } satisfies BlockRequest)
    })
    return response.result ?? false
  }

  close(): void {
    this.port.close()
    for (const [, p] of this.pending) {
      p.reject(new Error('ProxyBlockStore closed'))
    }
    this.pending.clear()
  }
}

if (parentPort) {
  parentPort.on('message', async (task: BuildCommitTask) => {
    if (task.type !== 'buildCommit') return

    const proxy = new ProxyBlockStore(task.port)
    try {
      const unsigned = await buildCommit(proxy, task.commitCid, task.input)

      const result: CommitResult = {
        type: 'commitResult',
        taskId: task.taskId,
        result: {
          did: unsigned.did,
          version: unsigned.version,
          data: unsigned.data,
          rev: unsigned.rev,
          prev: unsigned.prev,
          newBlocks: Array.from(unsigned.newBlocks.entries()),
          removedCids: unsigned.removedCids,
        },
      }
      parentPort!.postMessage(result)
    } catch (err) {
      const error: CommitError = {
        type: 'commitError',
        taskId: task.taskId,
        error: err instanceof Error ? err.message : String(err),
      }
      parentPort!.postMessage(error)
    } finally {
      proxy.close()
    }
  })
}
