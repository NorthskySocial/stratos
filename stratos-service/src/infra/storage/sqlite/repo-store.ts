/**
 * SQLite Repo Store Adapter
 *
 * Implements RepoStoreReader/Writer for SQLite backend.
 */
import { type Cid as CID } from '@atproto/lex-data'
import { eq, sql } from 'drizzle-orm'
import type {
  RepoBlock,
  RepoState,
  RepoStoreReader,
  RepoStoreWriter,
} from '@northskysocial/stratos-core'
import {
  parseCid,
  type StratosDb,
  stratosRepoBlock,
  stratosRepoRoot,
} from '@northskysocial/stratos-core'

/**
 * SQLite implementation of RepoStoreReader
 */
export class SqliteRepoStoreReader implements RepoStoreReader {
  constructor(protected db: StratosDb) {}

  /**
   * Get the root CID of the Repo
   * @returns The root CID, or null if not found.
   */
  async getRoot(): Promise<CID | null> {
    const rows = await this.db
      .select({ cid: stratosRepoRoot.cid })
      .from(stratosRepoRoot)
      .limit(1)

    const row = rows[0]
    if (!row?.cid) return null

    return parseCid(row.cid)
  }

  /**
   * Get the revision of the Repo
   * @returns The revision, or null if not found.
   */
  async getRev(): Promise<string | null> {
    const rows = await this.db
      .select({ rev: stratosRepoRoot.rev })
      .from(stratosRepoRoot)
      .limit(1)

    return rows[0]?.rev ?? null
  }

  /**
   * Get the state of the Repo
   * @returns The state, or null if not found.
   */
  async getState(): Promise<RepoState | null> {
    const rows = await this.db
      .select({ cid: stratosRepoRoot.cid, rev: stratosRepoRoot.rev })
      .from(stratosRepoRoot)
      .limit(1)

    const row = rows[0]
    if (!row?.cid || !row?.rev) return null

    return {
      root: parseCid(row.cid),
      rev: row.rev,
    }
  }

  /**
   * Get a block from the Repo
   * @param cid - The CID of the block to retrieve.
   * @returns The block content, or null if not found.
   */
  async getBlock(cid: CID): Promise<Uint8Array | null> {
    const rows = await this.db
      .select({ content: stratosRepoBlock.content })
      .from(stratosRepoBlock)
      .where(eq(stratosRepoBlock.cid, cid.toString()))
      .limit(1)

    return rows[0]?.content ?? null
  }

  /**
   * Check if a block exists in the Repo
   * @param cid - The CID of the block to check.
   * @returns True if the block exists, false otherwise.
   */
  async hasBlock(cid: CID): Promise<boolean> {
    const rows = await this.db
      .select({ cid: stratosRepoBlock.cid })
      .from(stratosRepoBlock)
      .where(eq(stratosRepoBlock.cid, cid.toString()))
      .limit(1)

    return rows.length > 0
  }

  /**
   * Get multiple blocks from the Repo
   * @param cids - The CIDs of the blocks to retrieve.
   * @returns A map of CID to block content, or null if not found.
   */
  async getBlocks(cids: CID[]): Promise<Map<string, Uint8Array>> {
    if (cids.length === 0) return new Map()

    const cidStrings = cids.map((c) => c.toString())
    const result = new Map<string, Uint8Array>()

    // Query in batches to avoid too many parameters
    const batchSize = 100
    for (let i = 0; i < cidStrings.length; i += batchSize) {
      const batch = cidStrings.slice(i, i + batchSize)
      const rows = await this.db
        .select({
          cid: stratosRepoBlock.cid,
          content: stratosRepoBlock.content,
        })
        .from(stratosRepoBlock)
        .where(
          sql`${stratosRepoBlock.cid} IN (${sql.join(
            batch.map((c) => sql`${c}`),
            sql`,`,
          )})`,
        )

      for (const row of rows) {
        result.set(row.cid, row.content)
      }
    }

    return result
  }

  /**
   * Get the count of blocks in the Repo
   * @returns The count of blocks.
   */
  async blockCount(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(stratosRepoBlock)

    return rows[0]?.count ?? 0
  }
}

/**
 * SQLite implementation of RepoStoreWriter
 */
export class SqliteRepoStoreWriter
  extends SqliteRepoStoreReader
  implements RepoStoreWriter
{
  /**
   * Update the root CID and revision in the Repo
   * @param root - The new root CID.
   * @param rev - The new revision.
   */
  async updateRoot(root: CID, rev: string): Promise<void> {
    await this.db
      .insert(stratosRepoRoot)
      .values({
        did: 'self', // Single row table
        cid: root.toString(),
        rev,
        indexedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: stratosRepoRoot.did,
        set: {
          cid: root.toString(),
          rev,
          indexedAt: new Date().toISOString(),
        },
      })
  }

  /**
   * Put a block into the Repo
   * @param cid - The CID of the block to store.
   * @param content - The content of the block.
   */
  async putBlock(cid: CID, content: Uint8Array): Promise<void> {
    await this.db
      .insert(stratosRepoBlock)
      .values({
        cid: cid.toString(),
        repoRev: '',
        size: content.length,
        content: Buffer.from(content),
      })
      .onConflictDoNothing()
  }

  /**
   * Put multiple blocks into the Repo
   * @param blocks - The blocks to store.
   */
  async putBlocks(blocks: RepoBlock[]): Promise<void> {
    if (blocks.length === 0) return

    await this.db
      .insert(stratosRepoBlock)
      .values(
        blocks.map((b) => ({
          cid: b.cid.toString(),
          repoRev: '',
          size: b.content.length,
          content: Buffer.from(b.content),
        })),
      )
      .onConflictDoNothing()
  }

  /**
   * Delete a block from the Repo
   * @param cid - The CID of the block to delete.
   */
  async deleteBlock(cid: CID): Promise<void> {
    await this.db
      .delete(stratosRepoBlock)
      .where(eq(stratosRepoBlock.cid, cid.toString()))
  }

  /**
   * Delete multiple blocks from the Repo
   * @param cids - The CIDs of the blocks to delete.
   */
  async deleteBlocks(cids: CID[]): Promise<void> {
    if (cids.length === 0) return

    const cidStrings = cids.map((c) => c.toString())
    await this.db.delete(stratosRepoBlock).where(
      sql`${stratosRepoBlock.cid} IN (${sql.join(
        cidStrings.map((c) => sql`${c}`),
        sql`,`,
      )})`,
    )
  }

  /**
   * Delete all blocks from the Repo
   */
  async clearBlocks(): Promise<void> {
    await this.db.delete(stratosRepoBlock)
  }
}
