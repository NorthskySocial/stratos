import { Secp256k1Keypair } from '@atproto/crypto'
import { encode as cborEncode, toBytes as cborToBytes } from '@atcute/cbor'
import type { CidLink } from '@atcute/cid'
import {
  create as cidCreate,
  fromString as cidFromString,
  toString as cidToString,
} from '@atcute/cid'
import {
  buildInclusionProof,
  MemoryBlockStore,
  NodeStore,
  OverlayBlockStore,
} from '@atcute/mst'
import { buildCommit } from '@northskysocial/stratos-core'
import { collectCarStream } from '@northskysocial/stratos-core/tests'

/**
 * builds a CAR file containing a signed commit and inclusion proof
 * for a single test record. shared across verification test suites.
 */
export async function buildSignedTestCar(
  keypair: Secp256k1Keypair,
  did: string,
  collection: string,
  rkey: string,
): Promise<{ carBytes: Uint8Array; recordCid: string }> {
  const recordData = cborEncode({
    text: 'test record',
    createdAt: '2025-01-01T00:00:00Z',
  })
  const recordAtcuteCid = await cidCreate(0x71, recordData)
  const recordCidStr = cidToString(recordAtcuteCid)

  const storage = new MemoryBlockStore()

  const unsigned = await buildCommit(storage, null, {
    did,
    writes: [{ action: 'create', collection, rkey, cid: recordCidStr }],
  })

  const unsignedCommit = {
    did: unsigned.did,
    version: unsigned.version as 3,
    data: { $link: unsigned.data } as CidLink,
    rev: unsigned.rev,
    prev: null,
  }

  const unsignedBytes = cborEncode(unsignedCommit)
  const sig = await keypair.sign(unsignedBytes)

  const signedCommit = {
    ...unsignedCommit,
    sig: cborToBytes(sig),
  }

  const commitBytes = cborEncode(signedCommit)
  const commitCid = await cidCreate(0x71, commitBytes)
  const commitCidStr = cidToString(commitCid)

  const newBlockStore = new MemoryBlockStore(unsigned.newBlocks)
  const overlay = new OverlayBlockStore(newBlockStore, storage)
  const nodeStore = new NodeStore(overlay)

  const proofCids = await buildInclusionProof(
    nodeStore,
    unsigned.data,
    `${collection}/${rkey}`,
  )

  const blockMap = new Map<string, Uint8Array>()
  blockMap.set(commitCidStr, commitBytes)

  for (const [cidStr, bytes] of unsigned.newBlocks) {
    blockMap.set(cidStr, bytes)
  }

  for (const proofCidStr of proofCids) {
    if (!blockMap.has(proofCidStr)) {
      const bytes = await overlay.get(proofCidStr)
      if (bytes) blockMap.set(proofCidStr, bytes)
    }
  }

  blockMap.set(recordCidStr, recordData)

  const carBlocks: Array<{ cid: Uint8Array; data: Uint8Array }> = []
  for (const [cidStr, bytes] of blockMap) {
    carBlocks.push({ cid: cidFromString(cidStr).bytes, data: bytes })
  }

  const carBytes = await collectCarStream([{ $link: commitCidStr }], carBlocks)

  return { carBytes, recordCid: recordCidStr }
}
