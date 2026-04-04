import { Cid } from '@atproto/lex-data'
import { encode as cborEncode, toBytes as cborToBytes } from '@atcute/cbor'
import type { CidLink } from '@atcute/cid'
import { create as cidCreate, toString as cidToString } from '@atcute/cid'
import type { Keypair } from '@atproto/crypto'
import {
  BlockMap,
  parseCid,
  type UnsignedCommitData,
} from '@northskysocial/stratos-core'
import { ActorRepoTransactor } from '../../../actor-store-types.js'
import { WritePhases } from '../../../api/index.js'

export interface SignedCommitResult {
  commitCid: Cid
  commitBytes: Uint8Array
  rev: string
}

export interface SignedCommitData {
  commitCid: Cid
  commitBytes: Uint8Array
  rev: string
  allBlocks: BlockMap
  removedCids: Cid[]
}

export interface ExtraBlock {
  cid: Cid
  bytes: Uint8Array
}

/**
 * Sign a commit with the given signing key and unsigned commit data.
 * @param signingKey - The signing key to use.
 * @param unsigned - The unsigned commit data to sign.
 * @param extraBlocks - Optional extra blocks to include in the commit.
 * @returns A promise that resolves to the signed commit data.
 */
export async function signCommit(
  signingKey: Keypair,
  unsigned: UnsignedCommitData,
  extraBlocks?: ExtraBlock[],
): Promise<SignedCommitData> {
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
  const commitCid = parseCid(commitCidStr)

  const allBlocks = new BlockMap()
  if (extraBlocks) {
    for (const block of extraBlocks) {
      allBlocks.set(block.cid, block.bytes)
    }
  }
  for (const [cidStr, bytes] of unsigned.newBlocks) {
    allBlocks.set(parseCid(cidStr), bytes)
  }
  allBlocks.set(commitCid, commitBytes)

  const removedCids = unsigned.removedCids.map((s) => parseCid(s))

  return {
    commitCid,
    commitBytes,
    rev: unsigned.rev,
    allBlocks,
    removedCids,
  }
}

/**
 * Sign and persist a commit to the repository.
 * @param repoTransactor - The repository transactor to use.
 * @param signingKey - The signing key to use.
 * @param unsigned - The unsigned commit data to sign and persist.
 * @param phases - Optional phases to track performance metrics.
 * @param extraBlocks - Optional extra blocks to include in the commit.
 * @returns A promise that resolves to the signed commit result.
 */
export async function signAndPersistCommit(
  repoTransactor: ActorRepoTransactor,
  signingKey: Keypair,
  unsigned: UnsignedCommitData,
  phases?: WritePhases,
  extraBlocks?: ExtraBlock[],
): Promise<SignedCommitResult> {
  let t0 = performance.now()
  const signed = await signCommit(signingKey, unsigned, extraBlocks)
  if (phases) phases.transactSign = performance.now() - t0

  t0 = performance.now()
  await repoTransactor.putBlocks(signed.allBlocks, unsigned.rev)
  if (phases) phases.transactPutBlocks = performance.now() - t0

  if (signed.removedCids.length > 0) {
    t0 = performance.now()
    await repoTransactor.deleteBlocks(signed.removedCids)
    if (phases) phases.transactDeleteBlocks = performance.now() - t0
  }

  t0 = performance.now()
  await repoTransactor.updateRoot(signed.commitCid, unsigned.rev, unsigned.did)
  if (phases) phases.transactUpdateRoot = performance.now() - t0

  return {
    commitCid: signed.commitCid,
    commitBytes: signed.commitBytes,
    rev: signed.rev,
  }
}
