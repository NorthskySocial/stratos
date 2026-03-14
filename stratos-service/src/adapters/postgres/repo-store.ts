import { CID } from 'multiformats/cid'
import { eq, sql } from 'drizzle-orm'
import type {
  RepoStoreReader,
  RepoStoreWriter,
  RepoBlock,
  RepoState,
} from '@northskysocial/stratos-core'
import {
  type StratosPgDb,
  type StratosPgDbOrTx,
  pgStratosRepoBlock,
  pgStratosRepoRoot,
} from '@northskysocial/stratos-core'

export class PgRepoStoreReader implements RepoStoreReader {
  constructor(protected db: StratosPgDb | StratosPgDbOrTx) {}

  async getRoot(): Promise<CID | null> {
    const rows = await this.db
      .select({ cid: pgStratosRepoRoot.cid })
      .from(pgStratosRepoRoot)
      .limit(1)

    const row = rows[0]
    if (!row?.cid) return null

    return CID.parse(row.cid)
  }

  async getRev(): Promise<string | null> {
    const rows = await this.db
      .select({ rev: pgStratosRepoRoot.rev })
      .from(pgStratosRepoRoot)
      .limit(1)

    return rows[0]?.rev ?? null
  }

  async getState(): Promise<RepoState | null> {
    const rows = await this.db
      .select({ cid: pgStratosRepoRoot.cid, rev: pgStratosRepoRoot.rev })
      .from(pgStratosRepoRoot)
      .limit(1)

    const row = rows[0]
    if (!row?.cid || !row?.rev) return null

    return {
      root: CID.parse(row.cid),
      rev: row.rev,
    }
  }

  async getBlock(cid: CID): Promise<Uint8Array | null> {
    const rows = await this.db
      .select({ content: pgStratosRepoBlock.content })
      .from(pgStratosRepoBlock)
      .where(eq(pgStratosRepoBlock.cid, cid.toString()))
      .limit(1)

    const content = rows[0]?.content
    return content ? new Uint8Array(content) : null
  }

  async hasBlock(cid: CID): Promise<boolean> {
    const rows = await this.db
      .select({ cid: pgStratosRepoBlock.cid })
      .from(pgStratosRepoBlock)
      .where(eq(pgStratosRepoBlock.cid, cid.toString()))
      .limit(1)

    return rows.length > 0
  }

  async getBlocks(cids: CID[]): Promise<Map<string, Uint8Array>> {
    if (cids.length === 0) return new Map()

    const cidStrings = cids.map((c) => c.toString())
    const result = new Map<string, Uint8Array>()

    const batchSize = 100
    for (let i = 0; i < cidStrings.length; i += batchSize) {
      const batch = cidStrings.slice(i, i + batchSize)
      const rows = await this.db
        .select({
          cid: pgStratosRepoBlock.cid,
          content: pgStratosRepoBlock.content,
        })
        .from(pgStratosRepoBlock)
        .where(
          sql`${pgStratosRepoBlock.cid} IN (${sql.join(
            batch.map((c) => sql`${c}`),
            sql`,`,
          )})`,
        )

      for (const row of rows) {
        result.set(row.cid, new Uint8Array(row.content))
      }
    }

    return result
  }

  async blockCount(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(pgStratosRepoBlock)

    return Number(rows[0]?.count ?? 0)
  }
}

export class PgRepoStoreWriter
  extends PgRepoStoreReader
  implements RepoStoreWriter
{
  async updateRoot(root: CID, rev: string): Promise<void> {
    await this.db
      .insert(pgStratosRepoRoot)
      .values({
        did: 'self',
        cid: root.toString(),
        rev,
        indexedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: pgStratosRepoRoot.did,
        set: {
          cid: root.toString(),
          rev,
          indexedAt: new Date().toISOString(),
        },
      })
  }

  async putBlock(cid: CID, content: Uint8Array): Promise<void> {
    await this.db
      .insert(pgStratosRepoBlock)
      .values({
        cid: cid.toString(),
        repoRev: '',
        size: content.length,
        content: Buffer.from(content),
      })
      .onConflictDoNothing()
  }

  async putBlocks(blocks: RepoBlock[]): Promise<void> {
    if (blocks.length === 0) return

    await this.db
      .insert(pgStratosRepoBlock)
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

  async deleteBlock(cid: CID): Promise<void> {
    await this.db
      .delete(pgStratosRepoBlock)
      .where(eq(pgStratosRepoBlock.cid, cid.toString()))
  }

  async deleteBlocks(cids: CID[]): Promise<void> {
    if (cids.length === 0) return

    const cidStrings = cids.map((c) => c.toString())
    await this.db.delete(pgStratosRepoBlock).where(
      sql`${pgStratosRepoBlock.cid} IN (${sql.join(
        cidStrings.map((c) => sql`${c}`),
        sql`,`,
      )})`,
    )
  }

  async clearBlocks(): Promise<void> {
    await this.db.delete(pgStratosRepoBlock)
  }
}
