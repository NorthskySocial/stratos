import { eq, inArray } from 'drizzle-orm'
import { CID } from 'multiformats/cid'
import {
  StratosDbOrTx,
  stratosRepoRoot,
  stratosRepoBlock,
} from '../db/index.js'
import { Logger } from '../types.js'
import { StratosSqlRepoReader, BlockMap } from './reader.js'

/**
 * Transactor for stratos repo - extends reader with write capabilities
 */
export class StratosSqlRepoTransactor extends StratosSqlRepoReader {
  constructor(db: StratosDbOrTx, logger?: Logger) {
    super(db, logger)
  }

  async updateRoot(cid: CID, rev: string, did: string): Promise<void> {
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

  async putBlock(cid: CID, bytes: Uint8Array, rev: string): Promise<void> {
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
      this.cache.set(CID.parse(cidStr), content)
    }

    if (values.length === 0) return

    // Insert in batches to avoid SQLite limits
    for (let i = 0; i < values.length; i += 100) {
      const batch = values.slice(i, i + 100)
      await this.db.insert(stratosRepoBlock).values(batch).onConflictDoNothing()
    }
  }

  async deleteBlock(cid: CID): Promise<void> {
    await this.db
      .delete(stratosRepoBlock)
      .where(eq(stratosRepoBlock.cid, cid.toString()))

    this.cache.delete(cid)
  }

  async deleteBlocks(cids: CID[]): Promise<void> {
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

  async deleteBlocksForRev(rev: string): Promise<void> {
    await this.db
      .delete(stratosRepoBlock)
      .where(eq(stratosRepoBlock.repoRev, rev))
  }

  async clearCache(): Promise<void> {
    this.cache = new BlockMap()
  }
}
