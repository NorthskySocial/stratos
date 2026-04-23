import { TID } from '@atproto/common-web'
import { MstError } from '../shared'
import { type CidLink, decode as cborDecode } from '@atcute/cbor'
import {
  type BlockMap,
  MemoryBlockStore,
  mstDiff,
  MSTNode,
  NodeStore,
  NodeWrangler,
  OverlayBlockStore,
  type ReadonlyBlockStore,
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

/**
 * Build a new MST commit from a set of writes
 * @param storage - Block store for reading existing blocks
 * @param currentCommitCid - CID of the current commit, or null if starting a new repo
 * @param input - Write operations to include in the commit
 *
 * @returns Unsigned commit data for the new commit
 */
export async function buildCommit(
  storage: ReadonlyBlockStore,
  currentCommitCid: string | null,
  input: MstWriteInput,
): Promise<UnsignedCommitData> {
  const { currentRev, currentMstRoot } = await fetchCurrentCommitData(
    storage,
    currentCommitCid,
  )

  if (currentCommitCid !== null && input.writes.length === 0) {
    throw new MstError('Cannot create an empty commit on an existing repo')
  }

  const upperStore = new MemoryBlockStore()
  const overlay = new OverlayBlockStore(upperStore, storage)
  const nodeStore = new NodeStore(overlay)

  let root = await applyMstWrites(nodeStore, currentMstRoot, input.writes)

  // Allow empty initial commits (no writes, no existing root) by creating an empty MST node
  // we do this as RepoNotFound can mean many things and if we don't do this can lead to
  // not know if the service is not working or we just haven't created a record yet
  root = await handleEmptyMstRoot(nodeStore, currentCommitCid, root)

  const newBlocks: BlockMap = new Map(upperStore.blocks)
  const removedCids = await calculateRemovedCids(
    nodeStore,
    currentMstRoot,
    root,
  )

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

/**
 * Fetch the current commit data from the block store
 * @param storage - Block store for reading existing blocks
 * @param currentCommitCid - CID of the current commit, or null if starting a new repo
 * @returns Object containing the current revision and root CID of the MST
 */
async function fetchCurrentCommitData(
  storage: ReadonlyBlockStore,
  currentCommitCid: string | null,
): Promise<{ currentRev: string | undefined; currentMstRoot: string | null }> {
  let currentRev: string | undefined
  let currentMstRoot: string | null = null

  if (currentCommitCid !== null) {
    const commitBytes = await storage.get(currentCommitCid)
    if (!commitBytes) {
      throw new MstError(`Commit block not found: ${currentCommitCid}`)
    }
    const commitData = cborDecode(commitBytes) as { rev: string; data: CidLink }
    currentRev = commitData.rev
    currentMstRoot = commitData.data.$link
  }

  return { currentRev, currentMstRoot }
}

/**
 * Applies MST writes to the given root node and returns the new root CID.
 * If the root is null, creates an empty MST node.
 *
 * @param nodeStore - Node store for the MST
 * @param currentMstRoot - Current root CID of the MST, or null if starting a new repo
 * @param writes - Array of write operations to apply
 * @returns New root CID of the MST after applying the writes
 */
async function applyMstWrites(
  nodeStore: NodeStore,
  currentMstRoot: string | null,
  writes: MstWriteOp[],
): Promise<string | null> {
  const wrangler = new NodeWrangler(nodeStore)
  let root = currentMstRoot

  for (const write of writes) {
    const key = formatDataKey(write.collection, write.rkey)
    switch (write.action) {
      case 'create':
      case 'update':
        if (write.cid === null) {
          throw new MstError(`CID required for ${write.action} operation`)
        }
        root = await wrangler.putRecord(root, key, { $link: write.cid })
        break
      case 'delete':
        root = await wrangler.deleteRecord(root, key)
        break
    }
  }

  return root
}

/**
 * Handles the case where the MST root is null after applying writes.
 * If there is a current commit CID, throws an error. Otherwise, creates an empty MST node.
 *
 * @param nodeStore - Node store for the MST
 * @param currentCommitCid - CID of the current commit, or null if starting a new repo
 * @param root - New root CID of the MST after applying writes
 * @returns New root CID of the MST, either the existing root or a new empty node
 */
async function handleEmptyMstRoot(
  nodeStore: NodeStore,
  currentCommitCid: string | null,
  root: string | null,
): Promise<string> {
  if (root === null) {
    if (currentCommitCid !== null) {
      throw new MstError('MST root is null after applying writes')
    }
    const emptyNode = await nodeStore.put(MSTNode.empty())
    return (await emptyNode.cid()).$link
  }
  return root
}

/**
 * Calculates the list of CIDs that were removed between two MST roots.
 * Returns an empty array if no removals occurred.
 *
 * @param nodeStore - Node store for the MST
 * @param currentMstRoot - Current root CID of the MST, or null if starting a new repo
 * @param root - New root CID of the MST after applying writes
 * @returns Array of CIDs that were removed
 */
async function calculateRemovedCids(
  nodeStore: NodeStore,
  currentMstRoot: string | null,
  root: string,
): Promise<string[]> {
  if (currentMstRoot !== null && root !== currentMstRoot) {
    const [, deleted] = await mstDiff(nodeStore, currentMstRoot, root)
    return Array.from(deleted)
  }
  return []
}
