import { eq, gt, and, isNull, asc } from 'drizzle-orm'
import { CID } from 'multiformats/cid'
import { StratosDb, stratosBlob, stratosRecordBlob, stratosRecord } from '../db/index.js'
import { StatusAttr, BlobStore, Logger } from '../types.js'

/**
 * Blob metadata from the database
 */
export interface BlobMetadata {
  size: number
  mimeType?: string
}

/**
 * Reader for stratos blob metadata
 */
export class StratosBlobReader {
  constructor(
    protected db: StratosDb,
    protected blobstore: BlobStore,
    protected logger?: Logger,
  ) {}

  async getBlobMetadata(cid: CID): Promise<BlobMetadata | null> {
    const found = await this.db
      .select()
      .from(stratosBlob)
      .where(and(eq(stratosBlob.cid, cid.toString()), isNull(stratosBlob.takedownRef)))
      .limit(1)
    if (found.length === 0) {
      return null
    }
    return {
      size: found[0].size,
      mimeType: found[0].mimeType,
    }
  }

  async getBlob(cid: CID): Promise<{
    size: number
    mimeType?: string
    stream: AsyncIterable<Uint8Array>
  } | null> {
    const metadata = await this.getBlobMetadata(cid)
    if (!metadata) {
      return null
    }
    try {
      const stream = await this.blobstore.getStream(cid)
      return {
        ...metadata,
        stream,
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (err) {
      return null
    }
  }

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
        .innerJoin(stratosRecord, eq(stratosRecord.uri, stratosRecordBlob.recordUri))
        .where(
          and(
            gt(stratosRecord.repoRev, since),
            ...(cursor ? [gt(stratosRecordBlob.blobCid, cursor)] : []),
          ),
        )
        .orderBy(asc(stratosRecordBlob.blobCid))
        .limit(limit)
      return res.map((row) => row.blobCid)
    }

    const res = await this.db
      .selectDistinct({ blobCid: stratosRecordBlob.blobCid })
      .from(stratosRecordBlob)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(stratosRecordBlob.blobCid))
      .limit(limit)
    return res.map((row) => row.blobCid)
  }

  async getBlobTakedownStatus(cid: CID): Promise<StatusAttr | null> {
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

  async getRecordsForBlob(cid: CID): Promise<string[]> {
    const res = await this.db
      .select()
      .from(stratosRecordBlob)
      .where(eq(stratosRecordBlob.blobCid, cid.toString()))
    return res.map((row) => row.recordUri)
  }

  async hasBlob(cid: CID): Promise<boolean> {
    const res = await this.db
      .select({ cid: stratosBlob.cid })
      .from(stratosBlob)
      .where(eq(stratosBlob.cid, cid.toString()))
      .limit(1)
    return res.length > 0
  }
}
