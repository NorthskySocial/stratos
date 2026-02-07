import { eq } from 'drizzle-orm'
import { CID } from 'multiformats/cid'
import { StratosDb, stratosBlob, stratosRecordBlob } from '../db/index.js'
import { BlobStore, PreparedBlobRef, Logger } from '../types.js'
import { StratosBlobReader } from './reader.js'

/**
 * Transactor for stratos blob metadata
 */
export class StratosBlobTransactor extends StratosBlobReader {
  constructor(db: StratosDb, blobstore: BlobStore, logger?: Logger) {
    super(db, blobstore, logger)
  }

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

  async removeRecordBlobAssociations(recordUri: string): Promise<void> {
    await this.db
      .delete(stratosRecordBlob)
      .where(eq(stratosRecordBlob.recordUri, recordUri))
  }

  async updateBlobTakedown(
    cid: CID,
    takedown: { applied: boolean; ref?: string },
  ): Promise<void> {
    await this.db
      .update(stratosBlob)
      .set({ takedownRef: takedown.applied ? (takedown.ref ?? null) : null })
      .where(eq(stratosBlob.cid, cid.toString()))
  }

  async deleteOrphanBlobs(): Promise<CID[]> {
    // Using a subquery approach since Drizzle handles left joins differently
    const allBlobs = await this.db
      .select({ cid: stratosBlob.cid })
      .from(stratosBlob)

    const deletedCids: CID[] = []
    for (const { cid } of allBlobs) {
      const associations = await this.db
        .select({ blobCid: stratosRecordBlob.blobCid })
        .from(stratosRecordBlob)
        .where(eq(stratosRecordBlob.blobCid, cid))
        .limit(1)

      if (associations.length === 0) {
        const cidObj = CID.parse(cid)
        await this.blobstore.delete(cidObj)
        await this.db.delete(stratosBlob).where(eq(stratosBlob.cid, cid))
        deletedCids.push(cidObj)
      }
    }

    return deletedCids
  }
}
