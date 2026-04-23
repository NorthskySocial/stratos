import { eq } from 'drizzle-orm'
import type { Cid } from '@atproto/lex-data'
import { AtUri } from '@atproto/syntax'
import {
  stratosBacklink,
  StratosBacklink,
  StratosDbOrTx,
  stratosRecord,
  stratosRepoBlock,
} from '../db/index.js'
import { Logger } from '../types.js'
import { getStratosBacklinks, StratosRecordReader } from './reader.js'

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

  /**
   * Indexes a stratos record in the database.
   * @param uri - The URI of the record.
   * @param cid - The CID of the record.
   * @param record - The record content.
   * @param action - The action to perform ('create' or 'update').
   * @param repoRev - The repository revision.
   * @param timestamp - The timestamp for indexing.
   */
  async indexRecord(
    uri: AtUri | string,
    cid: Cid,
    record: Record<string, unknown> | null,
    action: 'create' | 'update' = 'create',
    repoRev: string,
    timestamp?: string,
  ): Promise<void> {
    const atUri = typeof uri === 'string' ? new AtUri(uri) : uri
    this.logger?.debug({ uri: atUri.toString() }, 'indexing stratos record')

    const row = {
      uri: atUri.toString(),
      cid: cid.toString(),
      collection: atUri.collection,
      rkey: atUri.rkey,
      repoRev: repoRev,
      indexedAt: timestamp ?? new Date().toISOString(),
    }

    if (!atUri.hostname.startsWith('did:')) {
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
      const backlinks = getStratosBacklinks(atUri, record)
      if (action === 'update') {
        // On update just recreate backlinks from scratch for the record
        await this.removeBacklinksByUri(atUri)
      }
      await this.addBacklinks(backlinks)
    }

    this.logger?.info({ uri: atUri.toString() }, 'indexed stratos record')
  }

  /**
   * Deletes a stratos record from the database.
   * @param uri - The URI of the record to delete.
   */
  async deleteRecord(uri: AtUri | string): Promise<void> {
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

  /**
   * Removes backlinks associated with a URI from the database.
   * @param uri - The URI of the record whose backlinks to remove.
   */
  async removeBacklinksByUri(uri: AtUri | string): Promise<void> {
    await this.db
      .delete(stratosBacklink)
      .where(eq(stratosBacklink.uri, uri.toString()))
  }

  /**
   * Adds backlinks to the database.
   * @param backlinks - An array of backlinks to add.
   */
  async addBacklinks(backlinks: StratosBacklink[]): Promise<void> {
    if (backlinks.length === 0) return
    await this.db
      .insert(stratosBacklink)
      .values(backlinks)
      .onConflictDoNothing()
  }

  /**
   * Updates the takedown status of a stratos record.
   * @param uri - The URI of the record to update.
   * @param takedown - The takedown status and reference.
   */
  async updateRecordTakedown(
    uri: string | AtUri,
    takedown: { applied: boolean; ref?: string },
  ): Promise<void> {
    await this.db
      .update(stratosRecord)
      .set({ takedownRef: takedown.applied ? (takedown.ref ?? null) : null })
      .where(eq(stratosRecord.uri, uri.toString()))
  }

  /**
   * Put a record into the store.
   *
   * @param record - The record to be stored.
   */
  async putRecord(record: {
    uri: string
    cid: Cid
    value: Record<string, unknown>
    content: Uint8Array
    indexedAt?: string
  }): Promise<void> {
    const uri = new AtUri(record.uri)

    // First store the block content
    await this.db
      .insert(stratosRepoBlock)
      .values({
        cid: record.cid.toString(),
        repoRev: '', // Will be set by indexRecord
        size: record.content.length,
        content: Buffer.from(record.content),
      })
      .onConflictDoNothing()

    // Then index the record
    await this.indexRecord(
      uri,
      record.cid,
      record.value,
      'create',
      '', // repo rev
      record.indexedAt,
    )
  }
}
