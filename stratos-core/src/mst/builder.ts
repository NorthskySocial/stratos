import { TID } from '@atproto/common-web'
import { decode as cborDecode, type CidLink } from '@atcute/cbor'
import {
  NodeStore,
  NodeWrangler,
  OverlayBlockStore,
  MemoryBlockStore,
  MSTNode,
  mstDiff,
  type ReadonlyBlockStore,
  type BlockMap,
} from '@atcute/mst'

export type { ReadonlyBlockStore, BlockMap }

export interface UnsignedCommitData {
  did: string
  version: 3
  data: string
  rev: string
  prev: null
  newBlocks: BlockMap
  removedCids: string[]
}

export interface MstWriteOp {
  action: 'create' | 'update' | 'delete'
  collection: string
  rkey: string
  cid: string | null
}

export interface MstWriteInput {
  did: string
  writes: MstWriteOp[]
}

function formatDataKey(collection: string, rkey: string): string {
  return `${collection}/${rkey}`
}

export async function buildCommit(
  storage: ReadonlyBlockStore,
  currentCommitCid: string | null,
  input: MstWriteInput,
): Promise<UnsignedCommitData> {
  let currentRev: string | undefined
  let currentMstRoot: string | null = null

  if (currentCommitCid !== null) {
    const commitBytes = await storage.get(currentCommitCid)
    if (!commitBytes) {
      throw new Error(`Commit block not found: ${currentCommitCid}`)
    }
    const commitData = cborDecode(commitBytes) as { rev: string; data: CidLink }
    currentRev = commitData.rev
    currentMstRoot = commitData.data.$link
  }

  if (currentCommitCid !== null && input.writes.length === 0) {
    throw new Error('Cannot create an empty commit on an existing repo')
  }

  const upperStore = new MemoryBlockStore()
  const overlay = new OverlayBlockStore(upperStore, storage)
  const nodeStore = new NodeStore(overlay)
  const wrangler = new NodeWrangler(nodeStore)

  let root = currentMstRoot

  for (const write of input.writes) {
    const key = formatDataKey(write.collection, write.rkey)
    switch (write.action) {
      case 'create':
      case 'update':
        if (write.cid === null) {
          throw new Error(`CID required for ${write.action} operation`)
        }
        root = await wrangler.putRecord(root, key, { $link: write.cid })
        break
      case 'delete':
        root = await wrangler.deleteRecord(root, key)
        break
    }
  }

  // Allow empty initial commits (no writes, no existing root) by creating an empty MST node
  // we do this as RepoNotFound can mean many things and if we don't do this can lead to
  // not know if the service is not working or we just haven't created a record yet
  if (root === null) {
    if (currentCommitCid !== null) {
      throw new Error('MST root is null after applying writes')
    }
    const emptyNode = await nodeStore.put(MSTNode.empty())
    root = (await emptyNode.cid()).$link
  }

  const newBlocks: BlockMap = new Map(upperStore.blocks)

  let removedCids: string[] = []
  if (currentMstRoot !== null && root !== currentMstRoot) {
    const [, deleted] = await mstDiff(nodeStore, currentMstRoot, root)
    removedCids = Array.from(deleted)
  }

  const rev = TID.nextStr(currentRev)

  return {
    did: input.did,
    version: 3,
    data: root,
    rev,
    prev: null,
    newBlocks,
    removedCids,
  }
}
