import { CID } from '@atproto/lex-data'

/**
 * A block in the repo (IPLD block)
 */
export interface RepoBlock {
  cid: CID
  content: Uint8Array
}

/**
 * Repo state information
 */
export interface RepoState {
  root: CID
  rev: string
}

/**
 * Port interface for reading repo data
 */
export interface RepoStoreReader {
  /** Get current repo root CID */
  getRoot(): Promise<CID | null>

  /** Get current revision */
  getRev(): Promise<string | null>

  /** Get current repo state (root + rev) */
  getState(): Promise<RepoState | null>

  /** Get a block by CID */
  getBlock(cid: CID): Promise<Uint8Array | null>

  /** Check if block exists */
  hasBlock(cid: CID): Promise<boolean>

  /** Get multiple blocks by CIDs */
  getBlocks(cids: CID[]): Promise<Map<string, Uint8Array>>

  /** Count total blocks */
  blockCount(): Promise<number>
}

/**
 * Port interface for writing repo data
 */
export interface RepoStoreWriter extends RepoStoreReader {
  /** Update repo root and revision */
  updateRoot(root: CID, rev: string): Promise<void>

  /** Store a single block */
  putBlock(cid: CID, content: Uint8Array): Promise<void>

  /** Store multiple blocks */
  putBlocks(blocks: RepoBlock[]): Promise<void>

  /** Delete a block */
  deleteBlock(cid: CID): Promise<void>

  /** Delete multiple blocks */
  deleteBlocks(cids: CID[]): Promise<void>

  /** Delete all blocks (dangerous - for cleanup only) */
  clearBlocks(): Promise<void>
}
