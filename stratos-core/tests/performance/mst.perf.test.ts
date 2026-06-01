import { describe, it } from 'vitest'
import { MemoryBlockStore } from '@atcute/mst'
import * as AtcuteCid from '@atcute/cid'
import {
  type CidLink,
  encode as cborEncode,
  toBytes as cborToBytes,
} from '@atcute/cbor'
import { buildCommit, type MstWriteOp } from '../../src'
import { makeCidStr } from '../utils'

async function persistAndMakeCommitCid(
  storage: MemoryBlockStore,
  unsigned: Awaited<ReturnType<typeof buildCommit>>,
): Promise<string> {
  for (const [cidStr, bytes] of unsigned.newBlocks.entries()) {
    await storage.put(cidStr, bytes)
  }
  const fakeCommitBlock = cborEncode({
    did: unsigned.did,
    version: 3,
    data: { $link: unsigned.data } as CidLink,
    rev: unsigned.rev,
    prev: unsigned.prev ? ({ $link: unsigned.prev } as CidLink) : null,
    sig: cborToBytes(new Uint8Array(64)),
  })
  const commitCid = AtcuteCid.toString(
    await AtcuteCid.create(0x71, fakeCommitBlock),
  )
  await storage.put(commitCid, fakeCommitBlock)
  return commitCid
}

const DID = 'did:plc:shinji-ikari'

describe('Performance: MST Build', () => {
  it('measures building a commit with 1000 records at once', async () => {
    const storage = new MemoryBlockStore()
    const recordCount = 1000
    const writes: MstWriteOp[] = []

    for (let i = 0; i < recordCount; i++) {
      writes.push({
        action: 'create',
        collection: 'app.bsky.feed.post',
        rkey: `rkey-${i}`,
        cid: await makeCidStr(`record-${i}`),
      })
    }

    const start = performance.now()
    const unsigned = await buildCommit(storage, null, {
      did: DID,
      writes,
    })
    const end = performance.now()

    const duration = end - start
    console.log(
      `[PERF] Built MST with ${recordCount} records (one batch) in ${duration.toFixed(2)}ms (${(duration / recordCount).toFixed(4)}ms/rec)`,
    )
    console.log(`[PERF] New blocks created: ${unsigned.newBlocks.size}`)
  })

  it('measures incremental MST updates (100 batches of 10 records)', async () => {
    const storage = new MemoryBlockStore()
    const batchCount = 100
    const recordsPerBatch = 10
    let currentCommitCid: string | null = null

    const start = performance.now()
    for (let b = 0; b < batchCount; b++) {
      const writes: MstWriteOp[] = []
      for (let i = 0; i < recordsPerBatch; i++) {
        writes.push({
          action: 'create',
          collection: 'app.bsky.feed.post',
          rkey: `batch-${b}-rec-${i}`,
          cid: await makeCidStr(`record-${b}-${i}`),
        })
      }

      const unsigned = await buildCommit(storage, currentCommitCid, {
        did: DID,
        writes,
      })
      currentCommitCid = await persistAndMakeCommitCid(storage, unsigned)
    }
    const end = performance.now()

    const duration = end - start
    const totalRecords = batchCount * recordsPerBatch
    console.log(
      `[PERF] Built MST with ${totalRecords} records (incremental) in ${duration.toFixed(2)}ms (${(duration / totalRecords).toFixed(4)}ms/rec)`,
    )
  })
})
