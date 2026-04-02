import { CID } from '@atproto/lex-data'
import { eq, sql } from 'drizzle-orm'
import type {
  BlobMetadata,
  BlobMetadataReader,
  BlobMetadataWriter,
} from '@northskysocial/stratos-core'
import {
  pgStratosBlob,
  pgStratosRecordBlob,
  type StratosPgDb,
  type StratosPgDbOrTx,
} from '@northskysocial/stratos-core'

export class PgBlobMetadataReader implements BlobMetadataReader {
  constructor(
    protected db: StratosPgDb | StratosPgDbOrTx,
    protected schemaName?: string,
  ) {}

  async getBlobMetadata(cid: CID): Promise<BlobMetadata | null> {
    return this.withDb(async (db) => {
      const rows = await db
        .select()
        .from(pgStratosBlob)
        .where(eq(pgStratosBlob.cid, cid.toString()))
        .limit(1)

      const row = rows[0]
      if (!row) return null

      return {
        cid,
        mimeType: row.mimeType,
        size: row.size,
        width: row.width ?? undefined,
        height: row.height ?? undefined,
        createdAt: row.createdAt,
        takedownRef: row.takedownRef ?? undefined,
      }
    })
  }

  async hasBlob(cid: CID): Promise<boolean> {
    return this.withDb(async (db) => {
      const rows = await db
        .select({ cid: pgStratosBlob.cid })
        .from(pgStratosBlob)
        .where(eq(pgStratosBlob.cid, cid.toString()))
        .limit(1)

      return rows.length > 0
    })
  }

  async listBlobsForRecord(recordUri: string): Promise<BlobMetadata[]> {
    return this.withDb(async (db) => {
      const rows = await db
        .select({
          cid: pgStratosBlob.cid,
          mimeType: pgStratosBlob.mimeType,
          size: pgStratosBlob.size,
          width: pgStratosBlob.width,
          height: pgStratosBlob.height,
          createdAt: pgStratosBlob.createdAt,
          takedownRef: pgStratosBlob.takedownRef,
        })
        .from(pgStratosRecordBlob)
        .innerJoin(
          pgStratosBlob,
          eq(pgStratosBlob.cid, pgStratosRecordBlob.blobCid),
        )
        .where(eq(pgStratosRecordBlob.recordUri, recordUri))

      return rows.map((row) => ({
        cid: CID.parse(row.cid),
        mimeType: row.mimeType,
        size: row.size,
        width: row.width ?? undefined,
        height: row.height ?? undefined,
        createdAt: row.createdAt,
        takedownRef: row.takedownRef ?? undefined,
      }))
    })
  }

  async listAllBlobCids(): Promise<CID[]> {
    return this.withDb(async (db) => {
      const rows = await db
        .select({ cid: pgStratosBlob.cid })
        .from(pgStratosBlob)

      return rows.map((row) => CID.parse(row.cid))
    })
  }

  protected async withDb<T>(fn: (db: StratosPgDb) => Promise<T>): Promise<T> {
    if (!this.schemaName) {
      return fn(this.db as StratosPgDb)
    }
    return (this.db as StratosPgDb).transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${this.schemaName}"`))
      return fn(tx as unknown as StratosPgDb)
    })
  }
}

export class PgBlobMetadataWriter
  extends PgBlobMetadataReader
  implements BlobMetadataWriter
{
  async trackBlob(blob: {
    cid: CID
    mimeType: string
    size: number
    tempKey?: string | null
    width?: number | null
    height?: number | null
  }): Promise<void> {
    await this.db
      .insert(pgStratosBlob)
      .values({
        cid: blob.cid.toString(),
        mimeType: blob.mimeType,
        size: blob.size,
        tempKey: blob.tempKey ?? null,
        width: blob.width ?? null,
        height: blob.height ?? null,
        createdAt: new Date().toISOString(),
        takedownRef: null,
      })
      .onConflictDoNothing()
  }

  async associateBlobWithRecord(
    blobCid: CID,
    recordUri: string,
  ): Promise<void> {
    await this.db
      .insert(pgStratosRecordBlob)
      .values({
        blobCid: blobCid.toString(),
        recordUri,
      })
      .onConflictDoNothing()
  }

  async removeRecordBlobAssociations(recordUri: string): Promise<void> {
    await this.db
      .delete(pgStratosRecordBlob)
      .where(eq(pgStratosRecordBlob.recordUri, recordUri))
  }

  async deleteBlob(cid: CID): Promise<void> {
    await this.db
      .delete(pgStratosBlob)
      .where(eq(pgStratosBlob.cid, cid.toString()))
  }

  async takedownBlob(cid: CID, takedownRef: string): Promise<void> {
    await this.db
      .update(pgStratosBlob)
      .set({ takedownRef })
      .where(eq(pgStratosBlob.cid, cid.toString()))
  }

  async restoreBlob(cid: CID): Promise<void> {
    await this.db
      .update(pgStratosBlob)
      .set({ takedownRef: null })
      .where(eq(pgStratosBlob.cid, cid.toString()))
  }
}
