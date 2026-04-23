import { Cid } from '@atproto/lex-data'

/**
 * A block in the repo (IPLD block)
 */
export interface RepoBlock {
  cid: Cid
  content: Uint8Array
}

/**
 * Repo state information
 */
export interface RepoState {
  root: Cid
  rev: string
}

/**
 * Port interface for reading repo data
 */
export interface RepoStoreReader {
  /** Get current repo root CID */
  getRoot: () => Promise<Cid | null>

  /** Get current revision */
  getRev: () => Promise<string | null>

  /** Get current repo state (root + rev) */
  getState: () => Promise<RepoState | null>

  /** Get a block by CID */
  getBlock: (cid: Cid) => Promise<Uint8Array | null>

  /** Check if block exists */
  hasBlock: (cid: Cid) => Promise<boolean>

  /** Get multiple blocks by CIDs */
  getBlocks: (cids: Cid[]) => Promise<Map<string, Uint8Array>>

  /** Count total blocks */
  blockCount: () => Promise<number>
}

/**
 * Port interface for writing repo data
 */
export interface RepoStoreWriter extends RepoStoreReader {
  /** Update repo root and revision */
  updateRoot: (root: Cid, rev: string) => Promise<void>

  /** Store a single block */
  putBlock: (cid: Cid, content: Uint8Array) => Promise<void>

  /** Store multiple blocks */
  putBlocks: (blocks: RepoBlock[]) => Promise<void>

  /** Delete a block */
  deleteBlock: (cid: Cid) => Promise<void>

  /** Delete multiple blocks */
  deleteBlocks: (cids: Cid[]) => Promise<void>

  /** Delete all blocks (dangerous - for cleanup only) */
  clearBlocks: () => Promise<void>
}
