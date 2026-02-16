import { eq } from 'drizzle-orm'
import { CID } from 'multiformats/cid'
import { AtUri } from '@atproto/syntax'
import {
  StratosDbOrTx,
  stratosRecord,
  stratosBacklink,
  StratosBacklink,
} from '../db/index.js'
import { Logger } from '../types.js'
import { StratosRecordReader, getStratosBacklinks } from './reader.js'

/**
 * Transactor for stratos records - extends reader with write capabilities
 */
export class StratosRecordTransactor extends StratosRecordReader {
  constructor(
    db: StratosDbOrTx,
    cborToRecord: (content: Uint8Array) => Record<string, unknown>,
    logger?: Logger,
  ) {
    super(db, cborToRecord, logger)
  }

  async indexRecord(
    uri: AtUri,
    cid: CID,
    record: Record<string, unknown> | null,
    action: 'create' | 'update' = 'create',
    repoRev: string,
    timestamp?: string,
  ): Promise<void> {
    this.logger?.debug({ uri: uri.toString() }, 'indexing stratos record')

    const row = {
      uri: uri.toString(),
      cid: cid.toString(),
      collection: uri.collection,
      rkey: uri.rkey,
      repoRev: repoRev,
      indexedAt: timestamp || new Date().toISOString(),
    }

    if (!uri.hostname.startsWith('did:')) {
      throw new Error('Expected indexed URI to contain DID')
    } else if (row.collection.length < 1) {
      throw new Error('Expected indexed URI to contain a collection')
    } else if (row.rkey.length < 1) {
      throw new Error('Expected indexed URI to contain a record key')
    }

    await this.db
      .insert(stratosRecord)
      .values({
        ...row,
        takedownRef: null,
      })
      .onConflictDoUpdate({
        target: stratosRecord.uri,
        set: {
          cid: row.cid,
          repoRev: repoRev,
          indexedAt: row.indexedAt,
        },
      })

    if (record !== null) {
      const backlinks = getStratosBacklinks(uri, record)
      if (action === 'update') {
        // On update just recreate backlinks from scratch for the record
        await this.removeBacklinksByUri(uri)
      }
      await this.addBacklinks(backlinks)
    }

    this.logger?.info({ uri: uri.toString() }, 'indexed stratos record')
  }

  async deleteRecord(uri: AtUri): Promise<void> {
    this.logger?.debug(
      { uri: uri.toString() },
      'deleting indexed stratos record',
    )

    await Promise.all([
      this.db
        .delete(stratosRecord)
        .where(eq(stratosRecord.uri, uri.toString())),
      this.db
        .delete(stratosBacklink)
        .where(eq(stratosBacklink.uri, uri.toString())),
    ])

    this.logger?.info({ uri: uri.toString() }, 'deleted indexed stratos record')
  }

  async removeBacklinksByUri(uri: AtUri): Promise<void> {
    await this.db
      .delete(stratosBacklink)
      .where(eq(stratosBacklink.uri, uri.toString()))
  }

  async addBacklinks(backlinks: StratosBacklink[]): Promise<void> {
    if (backlinks.length === 0) return
    await this.db
      .insert(stratosBacklink)
      .values(backlinks)
      .onConflictDoNothing()
  }

  async updateRecordTakedown(
    uri: AtUri,
    takedown: { applied: boolean; ref?: string },
  ): Promise<void> {
    await this.db
      .update(stratosRecord)
      .set({ takedownRef: takedown.applied ? (takedown.ref ?? null) : null })
      .where(eq(stratosRecord.uri, uri.toString()))
  }
}
