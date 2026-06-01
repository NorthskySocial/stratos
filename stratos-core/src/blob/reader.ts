import { and, asc, eq, gt, isNull } from 'drizzle-orm'
import type { Cid } from '@atproto/lex-data'
import {
  stratosBlob,
  stratosBlobBoundary,
  StratosDbOrTx,
  stratosRecord,
  stratosRecordBlob,
} from '../db'
import { BlobNotFoundError, BlobStore, Logger, StatusAttr } from '../types.js'

/**
 * Blob metadata from the database
 */
export interface BlobMetadata {
  size: number
  mimeType?: string
  tempKey?: string | null
}

/**
 * Reader for stratos blob metadata
 */
export class StratosBlobReader {
  constructor(
    protected db: StratosDbOrTx,
    protected blobstore: BlobStore,
    protected logger?: Logger,
  ) {}

  /**
   * Retrieves metadata for a blob from the database.
   * @param cid - CID of the blob to retrieve metadata for.
   * @returns A promise that resolves with the blob metadata if found, or null if not found.
   */
  async getBlobMetadata(cid: Cid): Promise<BlobMetadata | null> {
    const found = await this.db
      .select()
      .from(stratosBlob)
      .where(
        and(
          eq(stratosBlob.cid, cid.toString()),
          isNull(stratosBlob.takedownRef),
        ),
      )
      .limit(1)
    if (found.length === 0) {
      return null
    }
    return {
      size: found[0].size,
      mimeType: found[0].mimeType,
      tempKey: found[0].tempKey,
    }
  }

  /**
   * Retrieves a blob from the database and blobstore.
   * @param cid - CID of the blob to retrieve.
   * @returns A promise that resolves with the blob metadata and stream if found, or null if not found.
   */
  async getBlob(cid: Cid): Promise<{
    size: number
    mimeType?: string
    tempKey?: string | null
    stream: AsyncIterable<Uint8Array>
  } | null> {
    const metadata = await this.getBlobMetadata(cid)
    if (!metadata) {
      return null
    }
    try {
      let stream: AsyncIterable<Uint8Array>
      try {
        stream = await this.blobstore.getStream(cid)
      } catch (err) {
        if (err instanceof BlobNotFoundError && metadata.tempKey) {
          this.logger?.info(
            `Blob ${cid.toString()} not found in permanent storage, falling back to temporary storage with key ${
              metadata.tempKey
            }`,
          )
          stream = await this.blobstore.getTempStream(metadata.tempKey)
        } else {
          throw err
        }
      }

      return {
        ...metadata,
        stream,
      }
    } catch (err) {
      this.logger?.error(
        `Failed to retrieve blob ${cid.toString()}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return null
    }
  }

  /**
   * Lists blobs in the database that are associated with records.
   * @param opts - Options for listing blobs.
   * @returns A promise that resolves with an array of CID objects of blobs associated with records.
   */
  async listBlobs(opts: {
    since?: string
    cursor?: string
    limit: number
  }): Promise<string[]> {
    const { since, cursor, limit } = opts

    const conditions = []
    if (cursor) {
      conditions.push(gt(stratosRecordBlob.blobCid, cursor))
    }

    if (since) {
      const res = await this.db
        .selectDistinct({ blobCid: stratosRecordBlob.blobCid })
        .from(stratosRecordBlob)
        .innerJoin(
          stratosRecord,
          eq(stratosRecord.uri, stratosRecordBlob.recordUri),
        )
        .where(
          and(
            gt(stratosRecord.repoRev, since),
            ...(cursor ? [gt(stratosRecordBlob.blobCid, cursor)] : []),
          ),
        )
        .orderBy(asc(stratosRecordBlob.blobCid))
        .limit(limit)
      return res.map((row: { blobCid: string }) => row.blobCid)
    }

    const res = await this.db
      .selectDistinct({ blobCid: stratosRecordBlob.blobCid })
      .from(stratosRecordBlob)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(stratosRecordBlob.blobCid))
      .limit(limit)
    return res.map((row: { blobCid: string }) => row.blobCid)
  }

  /**
   * Retrieves the takedown status of a blob from the database.
   * @param cid - CID of the blob to retrieve takedown status for.
   * @returns A promise that resolves with the takedown status if found, or null if not found.
   */
  async getBlobTakedownStatus(cid: Cid): Promise<StatusAttr | null> {
    const res = await this.db
      .select({ takedownRef: stratosBlob.takedownRef })
      .from(stratosBlob)
      .where(eq(stratosBlob.cid, cid.toString()))
      .limit(1)
    if (res.length === 0) return null
    return res[0].takedownRef
      ? { applied: true, ref: res[0].takedownRef }
      : { applied: false }
  }

  /**
   * Retrieves the records associated with a blob from the database.
   * @param cid - CID of the blob to retrieve records for.
   * @returns A promise that resolves with an array of record URIs associated with the blob.
   */
  async getRecordsForBlob(cid: Cid): Promise<string[]> {
    const res = await this.db
      .select()
      .from(stratosRecordBlob)
      .where(eq(stratosRecordBlob.blobCid, cid.toString()))
    return res.map((row: { recordUri: string }) => row.recordUri)
  }

  /**
   * Checks if a blob exists in the database.
   * @param cid - CID of the blob to check for existence.
   * @returns A promise that resolves with true if the blob exists, false otherwise.
   */
  async hasBlob(cid: Cid): Promise<boolean> {
    const res = await this.db
      .select({ cid: stratosBlob.cid })
      .from(stratosBlob)
      .where(eq(stratosBlob.cid, cid.toString()))
      .limit(1)
    return res.length > 0
  }

  /**
   * Retrieves the boundaries associated with a blob from the database.
   * @param blobCid - CID of the blob to retrieve boundaries for.
   * @returns A promise that resolves with an array of boundaries associated with the blob.
   */
  async getBoundariesForBlob(blobCid: Cid): Promise<string[]> {
    const res = await this.db
      .select({ boundary: stratosBlobBoundary.boundary })
      .from(stratosBlobBoundary)
      .where(eq(stratosBlobBoundary.blobCid, blobCid.toString()))
    return res.map((row) => row.boundary)
  }
}
