import { CID } from 'multiformats/cid'
import { eq } from 'drizzle-orm'
import type {
  BlobMetadataReader,
  BlobMetadataWriter,
  BlobMetadata,
} from '@northskysocial/stratos-core'
import {
  type StratosPgDb,
  type StratosPgDbOrTx,
  pgStratosBlob,
  pgStratosRecordBlob,
} from '@northskysocial/stratos-core'

export class PgBlobMetadataReader implements BlobMetadataReader {
  constructor(protected db: StratosPgDb | StratosPgDbOrTx) {}

  async getBlobMetadata(cid: CID): Promise<BlobMetadata | null> {
    const rows = await this.db
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
  }

  async hasBlob(cid: CID): Promise<boolean> {
    const rows = await this.db
      .select({ cid: pgStratosBlob.cid })
      .from(pgStratosBlob)
      .where(eq(pgStratosBlob.cid, cid.toString()))
      .limit(1)

    return rows.length > 0
  }

  async listBlobsForRecord(recordUri: string): Promise<BlobMetadata[]> {
    const rows = await this.db
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
  }

  async listAllBlobCids(): Promise<CID[]> {
    const rows = await this.db
      .select({ cid: pgStratosBlob.cid })
      .from(pgStratosBlob)

    return rows.map((row) => CID.parse(row.cid))
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
