/**
 * SQLite Blob Metadata Store Adapter
 *
 * Implements BlobMetadataReader/Writer for SQLite backend.
 */
import { CID } from 'multiformats/cid'
import { eq, isNull } from 'drizzle-orm'
import type {
  BlobMetadataReader,
  BlobMetadataWriter,
  BlobMetadata,
} from '@northsky/stratos-core'
import {
  StratosDb,
  stratosBlob,
  stratosRecordBlob,
} from '@northsky/stratos-core'

/**
 * SQLite implementation of BlobMetadataReader
 */
export class SqliteBlobMetadataReader implements BlobMetadataReader {
  constructor(protected db: StratosDb) {}

  async getBlobMetadata(cid: CID): Promise<BlobMetadata | null> {
    const rows = await this.db
      .select()
      .from(stratosBlob)
      .where(eq(stratosBlob.cid, cid.toString()))
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
      .select({ cid: stratosBlob.cid })
      .from(stratosBlob)
      .where(eq(stratosBlob.cid, cid.toString()))
      .limit(1)

    return rows.length > 0
  }

  async listBlobsForRecord(recordUri: string): Promise<BlobMetadata[]> {
    const rows = await this.db
      .select({
        cid: stratosBlob.cid,
        mimeType: stratosBlob.mimeType,
        size: stratosBlob.size,
        width: stratosBlob.width,
        height: stratosBlob.height,
        createdAt: stratosBlob.createdAt,
        takedownRef: stratosBlob.takedownRef,
      })
      .from(stratosRecordBlob)
      .innerJoin(stratosBlob, eq(stratosBlob.cid, stratosRecordBlob.blobCid))
      .where(eq(stratosRecordBlob.recordUri, recordUri))

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
      .select({ cid: stratosBlob.cid })
      .from(stratosBlob)

    return rows.map((row) => CID.parse(row.cid))
  }
}

/**
 * SQLite implementation of BlobMetadataWriter
 */
export class SqliteBlobMetadataWriter
  extends SqliteBlobMetadataReader
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
      .insert(stratosBlob)
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
      .insert(stratosRecordBlob)
      .values({
        blobCid: blobCid.toString(),
        recordUri,
      })
      .onConflictDoNothing()
  }

  async removeRecordBlobAssociations(recordUri: string): Promise<void> {
    await this.db
      .delete(stratosRecordBlob)
      .where(eq(stratosRecordBlob.recordUri, recordUri))
  }

  async deleteBlob(cid: CID): Promise<void> {
    await this.db.delete(stratosBlob).where(eq(stratosBlob.cid, cid.toString()))
  }

  async takedownBlob(cid: CID, takedownRef: string): Promise<void> {
    await this.db
      .update(stratosBlob)
      .set({ takedownRef })
      .where(eq(stratosBlob.cid, cid.toString()))
  }

  async restoreBlob(cid: CID): Promise<void> {
    await this.db
      .update(stratosBlob)
      .set({ takedownRef: null })
      .where(eq(stratosBlob.cid, cid.toString()))
  }
}
