import { CID } from 'multiformats/cid'
import { encode as cborEncode, toBytes as cborToBytes } from '@atcute/cbor'
import type { CidLink } from '@atcute/cid'
import { create as cidCreate, toString as cidToString } from '@atcute/cid'
import type { Keypair } from '@atproto/crypto'
import type { StratosSqlRepoTransactor } from '@northskysocial/stratos-core'
import { type UnsignedCommitData } from '@northskysocial/stratos-core'

export interface SignedCommitResult {
  commitCid: CID
  commitBytes: Uint8Array
  rev: string
}

export async function signAndPersistCommit(
  repoTransactor: StratosSqlRepoTransactor,
  signingKey: Keypair,
  unsigned: UnsignedCommitData,
): Promise<SignedCommitResult> {
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

  for (const [cidStr, bytes] of unsigned.newBlocks) {
    await repoTransactor.putBlock(CID.parse(cidStr), bytes, unsigned.rev)
  }

  if (unsigned.removedCids.length > 0) {
    await repoTransactor.deleteBlocks(unsigned.removedCids.map(s => CID.parse(s)))
  }

  await repoTransactor.putBlock(commitCid, commitBytes, unsigned.rev)
  await repoTransactor.updateRoot(commitCid, unsigned.rev, unsigned.did)

  return {
    commitCid,
    commitBytes,
    rev: unsigned.rev,
  }
}
