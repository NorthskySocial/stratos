import { CID } from 'multiformats/cid'
import { encode as cborEncode, toBytes as cborToBytes } from '@atcute/cbor'
import type { CidLink } from '@atcute/cid'
import { create as cidCreate, toString as cidToString } from '@atcute/cid'
import type { Keypair } from '@atproto/crypto'
import type { ActorRepoTransactor } from '../../actor-store-types.js'
import {
  type UnsignedCommitData,
  BlockMap,
} from '@northskysocial/stratos-core'
import type { WritePhases } from '../../api/records.js'

export interface SignedCommitResult {
  commitCid: CID
  commitBytes: Uint8Array
  rev: string
}

export async function signAndPersistCommit(
  repoTransactor: ActorRepoTransactor,
  signingKey: Keypair,
  unsigned: UnsignedCommitData,
  phases?: WritePhases,
): Promise<SignedCommitResult> {
  let t0 = performance.now()
  const unsignedCommit = {
    did: unsigned.did,
    version: unsigned.version as 3,
    data: { $link: unsigned.data } as CidLink,
    rev: unsigned.rev,
    prev: null,
  }

  const unsignedBytes = cborEncode(unsignedCommit)
  const sig = await signingKey.sign(unsignedBytes)

  const signedCommit = {
    ...unsignedCommit,
    sig: cborToBytes(sig),
  }

  const commitBytes = cborEncode(signedCommit)
  const atcuteCid = await cidCreate(0x71, commitBytes)
  const commitCidStr = cidToString(atcuteCid)
  const commitCid = CID.parse(commitCidStr)
  if (phases) phases.transactSign = performance.now() - t0

  const allBlocks = new BlockMap()
  for (const [cidStr, bytes] of unsigned.newBlocks) {
    allBlocks.set(CID.parse(cidStr), bytes)
  }
  allBlocks.set(commitCid, commitBytes)
  t0 = performance.now()
  await repoTransactor.putBlocks(allBlocks, unsigned.rev)
  if (phases) phases.transactPutBlocks = performance.now() - t0

  if (unsigned.removedCids.length > 0) {
    t0 = performance.now()
    await repoTransactor.deleteBlocks(
      unsigned.removedCids.map((s) => CID.parse(s)),
    )
    if (phases) phases.transactDeleteBlocks = performance.now() - t0
  }

  t0 = performance.now()
  await repoTransactor.updateRoot(commitCid, unsigned.rev, unsigned.did)
  if (phases) phases.transactUpdateRoot = performance.now() - t0

  return {
    commitCid,
    commitBytes,
    rev: unsigned.rev,
  }
}
