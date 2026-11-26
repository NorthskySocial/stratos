import { eq } from 'drizzle-orm'
import type { Cid } from '@atproto/lex-data'
import { AtUri } from '@atproto/syntax'
import {
  stratosBacklink,
  StratosBacklink,
  StratosDbOrTx,
  stratosRecord,
  stratosRecordBoundary,
  stratosRepoBlock,
} from '../db'
import { Logger } from '../types.js'
import { StratosValidator } from '../validation/index.js'
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
    const atUri = await this.indexRecordRow(uri, cid, repoRev, timestamp)
    if (record !== null) {
      await this.replaceBacklinks(atUri, record, action)
      await this.replaceRecordBoundaries(
        atUri,
        StratosValidator.extractBoundaryDomains(record),
      )
    }
    this.logger?.info({ uri: atUri.toString() }, 'indexed stratos record')
  }

  /**
   * Indexes a stratos record under a boundary the caller already authorized.
   * The boundary comes from the caller, never from the record body.
   */
  async indexRecordInBoundary(
    uri: AtUri | string,
    cid: Cid,
    record: Record<string, unknown>,
    boundary: string,
    action: 'create' | 'update',
    repoRev: string,
    timestamp?: string,
  ): Promise<void> {
    const atUri = await this.indexRecordRow(uri, cid, repoRev, timestamp)
    await this.replaceBacklinks(atUri, record, action)
    await this.replaceRecordBoundaries(atUri, [boundary])
    this.logger?.info({ uri: atUri.toString() }, 'indexed stratos record')
  }

  private async indexRecordRow(
    uri: AtUri | string,
    cid: Cid,
    repoRev: string,
    timestamp?: string,
  ): Promise<AtUri> {
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

    return atUri
  }

  private async replaceBacklinks(
    atUri: AtUri,
    record: Record<string, unknown>,
    action: 'create' | 'update',
  ): Promise<void> {
    const backlinks = getStratosBacklinks(atUri, record)
    if (action === 'update') {
      // On update just recreate backlinks from scratch for the record
      await this.removeBacklinksByUri(atUri)
    }
    await this.addBacklinks(backlinks)
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
      this.db
        .delete(stratosRecordBoundary)
        .where(eq(stratosRecordBoundary.recordUri, uri.toString())),
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
   * Replaces the boundary rows for a record with the given boundaries.
   * @param uri - The URI of the record.
   * @param boundaries - The boundaries the record now resides in.
   */
  async replaceRecordBoundaries(
    uri: AtUri | string,
    boundaries: readonly string[],
  ): Promise<void> {
    const recordUri = uri.toString()
    await this.db
      .delete(stratosRecordBoundary)
      .where(eq(stratosRecordBoundary.recordUri, recordUri))
    if (boundaries.length === 0) return
    await this.db
      .insert(stratosRecordBoundary)
      .values(boundaries.map((boundary) => ({ recordUri, boundary })))
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
