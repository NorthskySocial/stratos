import { eq, inArray } from 'drizzle-orm'
import type { Cid } from '@atproto/lex-data'
import { parseCid } from '../atproto/index.js'
import {
  StratosDbOrTx,
  stratosRepoBlock,
  stratosRepoRoot,
} from '../db/index.js'
import { Logger } from '../types.js'
import { BlockMap, StratosSqlRepoReader } from './reader.js'

/**
 * Transactor for stratos repo - extends reader with write capabilities
 */
export class StratosSqlRepoTransactor extends StratosSqlRepoReader {
  constructor(db: StratosDbOrTx, logger?: Logger) {
    super(db, logger)
  }

  /**
   * Lock the root of the repository for exclusive access.
   * @returns Detailed root information including CID and revision, or null if not found.
   */
  async lockRoot(): Promise<{ cid: Cid; rev: string } | null> {
    return this.getRootDetailed()
  }

  /**
   * Update the root of the repository with a new CID, revision, and DID.
   * @param cid - New CID for the root.
   * @param rev - New revision for the root.
   * @param did - New DID for the root.
   */
  async updateRoot(cid: Cid, rev: string, did: string): Promise<void> {
    await this.db
      .insert(stratosRepoRoot)
      .values({
        did,
        cid: cid.toString(),
        rev,
        indexedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: stratosRepoRoot.did,
        set: {
          cid: cid.toString(),
          rev,
          indexedAt: new Date().toISOString(),
        },
      })
  }

  /**
   * Store a block in the repository.
   * @param cid - CID of the block to store.
   * @param bytes - Bytes of the block content.
   * @param rev - Revision for which the block is being stored.
   */
  async putBlock(cid: Cid, bytes: Uint8Array, rev: string): Promise<void> {
    await this.db
      .insert(stratosRepoBlock)
      .values({
        cid: cid.toString(),
        repoRev: rev,
        size: bytes.length,
        content: Buffer.from(bytes),
      })
      .onConflictDoNothing()

    this.cache.set(cid, bytes)
  }

  /**
   * Store multiple blocks in the repository.
   * @param blocks - Map of CIDs to block content.
   * @param rev - Revision for which the blocks are being stored.
   */
  async putBlocks(blocks: BlockMap, rev: string): Promise<void> {
    const values: Array<{
      cid: string
      repoRev: string
      size: number
      content: Buffer
    }> = []

    for (const [cidStr, content] of blocks.entries()) {
      values.push({
        cid: cidStr,
        repoRev: rev,
        size: content.length,
        content: Buffer.from(content),
      })
      this.cache.set(parseCid(cidStr), content)
    }

    if (values.length === 0) return

    // Insert in batches to avoid SQLite limits
    for (let i = 0; i < values.length; i += 100) {
      const batch = values.slice(i, i + 100)
      await this.db.insert(stratosRepoBlock).values(batch).onConflictDoNothing()
    }
  }

  /**
   * Delete a block from the repository.
   * @param cid - CID of the block to delete.
   */
  async deleteBlock(cid: Cid): Promise<void> {
    await this.db
      .delete(stratosRepoBlock)
      .where(eq(stratosRepoBlock.cid, cid.toString()))

    this.cache.delete(cid)
  }

  /**
   * Delete multiple blocks from the repository.
   * @param cids - CIDs of the blocks to delete.
   */
  async deleteBlocks(cids: Cid[]): Promise<void> {
    if (cids.length === 0) return

    const cidStrs = cids.map((c) => c.toString())

    for (let i = 0; i < cidStrs.length; i += 500) {
      const batch = cidStrs.slice(i, i + 500)
      await this.db
        .delete(stratosRepoBlock)
        .where(inArray(stratosRepoBlock.cid, batch))
    }

    for (const cid of cids) {
      this.cache.delete(cid)
    }
  }

  /**
   * Delete all blocks for a given revision.
   * @param rev - Revision to delete blocks for.
   */
  async deleteBlocksForRev(rev: string): Promise<void> {
    await this.db
      .delete(stratosRepoBlock)
      .where(eq(stratosRepoBlock.repoRev, rev))
  }

  /**
   * Clears the repository block cache.
   */
  override async clearCache(): Promise<void> {
    this.cache = new BlockMap()
  }
}
