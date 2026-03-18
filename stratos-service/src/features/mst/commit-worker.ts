import { parentPort } from 'node:worker_threads'
import { MemoryBlockStore } from '@atcute/mst'
import { buildCommit } from '@northskysocial/stratos-core'
import type { MstWriteInput } from '@northskysocial/stratos-core'

interface BuildCommitRequest {
  id: number
  blocks: [string, Uint8Array][]
  currentCommitCid: string | null
  input: MstWriteInput
}

interface BuildCommitResponse {
  id: number
  result?: {
    did: string
    version: 3
    data: string
    rev: string
    prev: null
    newBlocks: [string, Uint8Array][]
    removedCids: string[]
  }
  error?: string
}

if (!parentPort) {
  throw new Error('commit-worker must be run as a worker thread')
}

parentPort.on('message', async (msg: BuildCommitRequest) => {
  try {
    const storage = new MemoryBlockStore()
    for (const [cid, bytes] of msg.blocks) {
      storage.blocks.set(cid, new Uint8Array(bytes))
    }

    const unsigned = await buildCommit(
      storage,
      msg.currentCommitCid,
      msg.input,
    )

    const response: BuildCommitResponse = {
      id: msg.id,
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

    parentPort!.postMessage(response)
  } catch (err) {
    const response: BuildCommitResponse = {
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
    }
    parentPort!.postMessage(response)
  }
})
