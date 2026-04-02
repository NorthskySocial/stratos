/**
 * SQLite Blob Metadata Store Adapter
 *
 * Implements BlobMetadataReader/Writer for SQLite backend.
 */
import { CID } from '@atproto/lex-data'
import { eq } from 'drizzle-orm'
import type {
  BlobMetadata,
  BlobMetadataReader,
  BlobMetadataWriter,
} from '@northskysocial/stratos-core'
import {
  stratosBlob,
  type StratosDb,
  stratosRecordBlob,
} from '@northskysocial/stratos-core'

/**
 * SQLite implementation of BlobMetadataReader
 */
export class SqliteBlobMetadataReader implements BlobMetadataReader {
  constructor(protected db: StratosDb) {}

  /**
   * Get blob metadata by CID.
   * @param cid CID of the blob.
   * @returns BlobMetadata object if found, null otherwise.
   */
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

  /**
   * Check if a blob exists by CID.
   * @param cid CID of the blob.
   * @returns True if the blob exists, false otherwise.
   */
  async hasBlob(cid: CID): Promise<boolean> {
    const rows = await this.db
      .select({ cid: stratosBlob.cid })
      .from(stratosBlob)
      .where(eq(stratosBlob.cid, cid.toString()))
      .limit(1)

    return rows.length > 0
  }

  /**
   * List blobs associated with a record URI.
   * @param recordUri URI of the record.
   * @returns Array of BlobMetadata objects for the record.
   */
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

  /**
   * List all CIDs of blobs.
   * @returns Array of CIDs of blobs.
   */
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
  /**
   * Track a new blob and store its metadata.
   * @param blob Blob metadata to track.
   */
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

  /**
   * Associate a blob with a record URI.
   * @param blobCid - CID of the blob.
   * @param recordUri - URI of the record.
   */
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

  /**
   * Remove all associations between a record URI and its blobs.
   * @param recordUri - URI of the record.
   */
  async removeRecordBlobAssociations(recordUri: string): Promise<void> {
    await this.db
      .delete(stratosRecordBlob)
      .where(eq(stratosRecordBlob.recordUri, recordUri))
  }

  /**
   * Delete a blob by CID.
   * @param cid - CID of the blob to delete.
   */
  async deleteBlob(cid: CID): Promise<void> {
    await this.db.delete(stratosBlob).where(eq(stratosBlob.cid, cid.toString()))
  }

  /**
   * Takedown a blob by CID.
   * @param cid - CID of the blob to takedown.
   * @param takedownRef - Reference to the takedown.
   */
  async takedownBlob(cid: CID, takedownRef: string): Promise<void> {
    await this.db
      .update(stratosBlob)
      .set({ takedownRef })
      .where(eq(stratosBlob.cid, cid.toString()))
  }

  /**
   * Restore a blob by CID.
   * @param cid - CID of the blob to restore.
   */
  async restoreBlob(cid: CID): Promise<void> {
    await this.db
      .update(stratosBlob)
      .set({ takedownRef: null })
      .where(eq(stratosBlob.cid, cid.toString()))
  }
}
