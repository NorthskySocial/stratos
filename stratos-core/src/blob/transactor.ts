import { eq } from 'drizzle-orm'
import { type Cid } from '@atproto/lex-data'
import { parseCid } from '../atproto/index.js'
import { stratosBlob, StratosDbOrTx, stratosRecordBlob } from '../db/index.js'
import { BlobStore, Logger, PreparedBlobRef } from '../types.js'
import { StratosBlobReader } from './reader.js'

/**
 * Transactor for stratos blob metadata
 */
export class StratosBlobTransactor extends StratosBlobReader {
  constructor(db: StratosDbOrTx, blobstore: BlobStore, logger?: Logger) {
    super(db, blobstore, logger)
  }

  /**
   * Tracks a blob by inserting its metadata into the database.
   * @param blob - The blob object to track.
   * @returns A promise that resolves when the blob is successfully tracked.
   */
  async trackBlob(blob: {
    cid: Cid
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
   * Associates a blob with a record by inserting a record-blob association into the database.
   * @param blobCid - CID of the blob to associate.
   * @param recordUri - URI of the record to associate with the blob.
   * @returns A promise that resolves when the association is successfully created.
   */
  async associateBlobWithRecord(
    blobCid: Cid,
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
   * Processes a list of blobs associated with a record, tracking them and associating them with the record.
   * @param recordUri - URI of the record to process blobs for.
   * @param blobs - Array of prepared blob references to process.
   * @returns A promise that resolves when all blobs are successfully processed.
   */
  async processBlobs(
    recordUri: string,
    blobs: PreparedBlobRef[],
  ): Promise<void> {
    for (const blob of blobs) {
      if (blob.tempKey) {
        await this.blobstore.makePermanent(blob.tempKey, blob.cid)
      }

      await this.trackBlob({
        cid: blob.cid,
        mimeType: blob.mimeType,
        size: 0,
        tempKey: null,
      })

      await this.associateBlobWithRecord(blob.cid, recordUri)
    }
  }

  /**
   * Removes all blob associations for a given record from the database.
   * @param recordUri - URI of the record to remove associations for.
   * @returns A promise that resolves when all associations are successfully removed.
   */
  async removeRecordBlobAssociations(recordUri: string): Promise<void> {
    await this.db
      .delete(stratosRecordBlob)
      .where(eq(stratosRecordBlob.recordUri, recordUri))
  }

  /**
   * Updates the takedown status of a blob in the database.
   * @param cid - CID of the blob to update.
   * @param takedown - Takedown information to set for the blob.
   * @returns A promise that resolves when the takedown status is successfully updated.
   */
  async updateBlobTakedown(
    cid: Cid,
    takedown: { applied: boolean; ref?: string },
  ): Promise<void> {
    await this.db
      .update(stratosBlob)
      .set({ takedownRef: takedown.applied ? (takedown.ref ?? null) : null })
      .where(eq(stratosBlob.cid, cid.toString()))
  }

  /**
   * Deletes blobs that are not associated with any record from the database and blobstore.
   * @returns A promise that resolves with an array of CID objects of deleted blobs.
   */
  async deleteOrphanBlobs(): Promise<Cid[]> {
    // Using a subquery approach since Drizzle handles left joins differently
    const allBlobs = await this.db
      .select({ cid: stratosBlob.cid })
      .from(stratosBlob)

    const deletedCids: Cid[] = []
    for (const { cid } of allBlobs) {
      const associations = await this.db
        .select({ blobCid: stratosRecordBlob.blobCid })
        .from(stratosRecordBlob)
        .where(eq(stratosRecordBlob.blobCid, cid))
        .limit(1)

      if (associations.length === 0) {
        const cidObj = parseCid(cid)
        await this.blobstore.delete(cidObj)
        await this.db.delete(stratosBlob).where(eq(stratosBlob.cid, cid))
        deletedCids.push(cidObj)
      }
    }

    return deletedCids
  }
}
