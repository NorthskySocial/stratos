import path from 'node:path'
import * as fs from 'node:fs/promises'
import * as crypto from '@atproto/crypto'
import { fileExists } from '@atproto/common'
import { AtUri } from '@atproto/syntax'
import {
  type BlobStore,
  type BlobStoreCreator,
  closeStratosDb,
  createStratosDb,
  type GetBacklinksOpts,
  type ListRecordsOpts,
  type Logger,
  migrateStratosDb,
  StratosBlobReader,
  StratosBlobTransactor,
  type StratosDbOrTx,
  StratosRecordReader,
  StratosRecordTransactor,
  StratosSqlRepoReader,
  StratosSqlRepoTransactor,
} from '@northskysocial/stratos-core'
import type {
  ActorReader,
  ActorRecordReader as IActorRecordReader,
  ActorRecordTransactor as IActorRecordTransactor,
  ActorStore,
  ActorTransactor,
} from '../../actor-store-types.js'
import { SqliteSequenceOps } from './sequence-ops.js'
import { Cid } from '@atproto/lex-data'

/**
 * Wrapper for StratosRecordReader that handles string | AtUri
 */
class SqliteActorRecordReader implements IActorRecordReader {
  constructor(public readonly reader: StratosRecordReader) {}

  /**
   * Get the total number of records in the store
   * @returns Total record count
   */
  recordCount() {
    return this.reader.recordCount()
  }

  /**
   * List all records in the store
   * @returns Array of ActorRecord objects
   */
  listAll() {
    return this.reader.listAll()
  }

  /**
   * List all unique collection URIs in the store
   * @returns Array of collection URIs
   */
  listCollections() {
    return this.reader.listCollections()
  }

  /**
   * List records for a specific collection
   * @param opts - Options for listing records
   * @returns Array of ActorRecord objects
   */
  listRecordsForCollection(opts: ListRecordsOpts) {
    return this.reader.listRecordsForCollection(opts)
  }

  /**
   * Get a specific record by URI and CID
   * @param uri - URI of the record
   * @param cid - CID of the record
   * @param includeSoftDeleted - Include soft-deleted records (default: false)
   * @returns ActorRecord object or undefined if not found
   */
  getRecord(
    uri: string | AtUri,
    cid: string | null,
    includeSoftDeleted?: boolean,
  ) {
    return this.reader.getRecord(uri, cid, includeSoftDeleted)
  }

  /**
   * Check if a record exists by URI and CID
   * @param uri - URI of the record
   * @param cid - CID of the record
   * @param includeSoftDeleted - Include soft-deleted records (default: false)
   * @returns True if record exists, false otherwise
   */
  hasRecord(
    uri: string | AtUri,
    cid: string | null,
    includeSoftDeleted?: boolean,
  ) {
    return this.reader.hasRecord(uri, cid, includeSoftDeleted)
  }

  /**
   * Get the takedown status of a record by URI
   * @param uri - URI of the record
   * @returns Takedown status of the record
   */
  getRecordTakedownStatus(uri: string | AtUri) {
    return this.reader.getRecordTakedownStatus(uri)
  }

  /**
   * Get the current CID of a record by URI
   * @param uri - URI of the record
   * @returns CID of the current record or undefined if not found
   */
  getCurrentRecordCid(uri: string | AtUri) {
    return this.reader.getCurrentRecordCid(uri)
  }

  /**
   * Get backlinks for a record by URI
   * @param opts - Options for getting backlinks
   * @returns Array of backlink records
   */
  getRecordBacklinks(opts: GetBacklinksOpts) {
    return this.reader.getRecordBacklinks(opts)
  }

  /**
   * Get backlink conflicts for a record by URI and record data
   * @param uri - URI of the record
   * @param record - Record data to check for conflicts
   * @returns Array of backlink conflicts
   */
  getBacklinkConflicts(uri: string | AtUri, record: Record<string, unknown>) {
    return this.reader.getBacklinkConflicts(uri, record)
  }
}

/**
 * Wrapper for StratosRecordTransactor that handles string | AtUri
 */
class SqliteActorRecordTransactor
  extends SqliteActorRecordReader
  implements IActorRecordTransactor
{
  constructor(private readonly transactor: StratosRecordTransactor) {
    super(transactor)
  }

  /**
   * Put a record with the given data
   * @param record - Record data to put
   * @returns Promise that resolves when the record is put
   */
  putRecord(record: {
    uri: string
    cid: Cid
    value: Record<string, unknown>
    content: Uint8Array
    indexedAt?: string
  }) {
    return this.transactor.putRecord(record)
  }

  /**
   * Index a record with the given data
   * @param uri - URI of the record
   * @param cid - CID of the record
   * @param record - Record data to index
   * @param action - Action type ('create' or 'update')
   * @param repoRev - Repository revision (optional)
   * @param timestamp - Timestamp (optional)
   * @returns Promise that resolves when the record is indexed
   */
  indexRecord(
    uri: string | AtUri,
    cid: Cid,
    record: Record<string, unknown> | null,
    action?: 'create' | 'update',
    repoRev?: string,
    timestamp?: string,
  ) {
    return this.transactor.indexRecord(
      uri,
      cid,
      record,
      action,
      repoRev ?? '',
      timestamp,
    )
  }

  /**
   * Delete a record by URI
   * @param uri - URI of the record to delete
   * @returns Promise that resolves when the record is deleted
   */
  deleteRecord(uri: string | AtUri) {
    return this.transactor.deleteRecord(uri)
  }

  /**
   * Remove backlinks for a record by URI
   * @param uri - URI of the record to remove backlinks for
   * @returns Promise that resolves when the backlinks are removed
   */
  removeBacklinksByUri(uri: string | AtUri) {
    return this.transactor.removeBacklinksByUri(uri)
  }

  /**
   * Add backlinks for a record
   * @param backlinks - Array of backlinks to add
   * @returns Promise that resolves when the backlinks are added
   */
  addBacklinks(
    backlinks: Array<{ uri: string | AtUri; path: string; linkTo: string }>,
  ) {
    return this.transactor.addBacklinks(
      backlinks.map((b) => ({
        uri: b.uri.toString(),
        path: b.path,
        linkTo: b.linkTo.toString(),
      })),
    )
  }

  /**
   * Update the takedown status of a record
   * @param uri - URI of the record to update
   * @param takedown - Takedown status and reference (optional)
   * @returns Promise that resolves when the takedown status is updated
   */
  updateRecordTakedown(
    uri: string | AtUri,
    takedown: { applied: boolean; ref?: string },
  ) {
    return this.transactor.updateRecordTakedown(uri, takedown)
  }
}

/**
 * StratosActorStore implements the ActorStore interface using SQLite as the underlying storage.
 */
export class StratosActorStore implements ActorStore {
  private readonly dataDir: string
  private readonly blobstore: BlobStoreCreator
  private readonly logger?: Logger
  private readonly existsCache = new Set<string>()
  private readonly cborToRecord: (
    content: Uint8Array,
  ) => Record<string, unknown>

  constructor(opts: {
    dataDir: string
    blobstore: BlobStoreCreator
    logger?: Logger
    cborToRecord: (content: Uint8Array) => Record<string, unknown>
  }) {
    this.dataDir = opts.dataDir
    this.blobstore = opts.blobstore
    this.logger = opts.logger
    this.cborToRecord = opts.cborToRecord
  }

  /**
   * Check if an actor with the given DID exists in the store.
   * @param did - The DID of the actor to check.
   * @returns A Promise resolving to true if the actor exists, false otherwise.
   */
  async exists(did: string): Promise<boolean> {
    if (this.existsCache.has(did)) return true
    const { dbLocation } = await this.getLocation(did)
    const found = await fileExists(dbLocation)
    if (found) this.existsCache.add(did)
    return found
  }

  /**
   * Create a new actor with the given DID in the store.
   * @param did - The DID of the actor to create.
   * @returns A Promise resolving when the actor is created.
   */
  async create(did: string): Promise<void> {
    const { directory, dbLocation } = await this.getLocation(did)
    await fs.mkdir(directory, { recursive: true })

    const db = createStratosDb(dbLocation)
    try {
      await db._initialized
      await migrateStratosDb(db)
    } finally {
      await closeStratosDb(db)
    }
    this.existsCache.add(did)
  }

  /**
   * Destroy an actor with the given DID from the store.
   * @param did - The DID of the actor to destroy.
   * @returns A Promise resolving when the actor is destroyed.
   */
  async destroy(did: string): Promise<void> {
    const { directory } = await this.getLocation(did)
    await fs.rm(directory, { recursive: true, force: true })
    this.existsCache.delete(did)
  }

  /**
   * Read data from an actor with the given DID.
   * @param did - The DID of the actor to read from.
   * @param fn - A function that takes an ActorReader and returns a value or Promise.
   * @returns A Promise resolving to the result of the provided function.
   */
  async read<T>(
    did: string,
    fn: (store: ActorReader) => T | PromiseLike<T>,
  ): Promise<T> {
    const { dbLocation } = await this.getLocation(did)
    const db = createStratosDb(dbLocation)
    await db._initialized
    const blobStore = this.blobstore(did)

    try {
      const store: ActorReader = {
        did,
        record: new SqliteActorRecordReader(
          new StratosRecordReader(db, this.cborToRecord, this.logger),
        ),
        repo: new StratosSqlRepoReader(db),
        blob: new StratosBlobReader(db, blobStore, this.logger),
        sequence: new SqliteSequenceOps(db),
      }
      return await fn(store)
    } finally {
      await closeStratosDb(db)
    }
  }

  /**
   * Perform a transactional operation on an actor with the given DID.
   * @param did - The DID of the actor to perform the transaction on.
   * @param fn - A function that takes an ActorTransactor and returns a value or Promise.
   * @returns A Promise resolving to the result of the provided function.
   */
  async transact<T>(
    did: string,
    fn: (store: ActorTransactor) => T | PromiseLike<T>,
  ): Promise<T> {
    const { dbLocation } = await this.getLocation(did)
    const db = createStratosDb(dbLocation)
    await db._initialized
    const blobStore = this.blobstore(did)

    try {
      return await db.transaction(async (tx) => {
        const txDb = tx as unknown as StratosDbOrTx
        const store: ActorTransactor = {
          did,
          record: new SqliteActorRecordTransactor(
            new StratosRecordTransactor(txDb, this.cborToRecord, this.logger),
          ),
          repo: new StratosSqlRepoTransactor(txDb),
          blob: new StratosBlobTransactor(txDb, blobStore, this.logger),
          sequence: new SqliteSequenceOps(txDb),
        }
        return fn(store)
      })
    } finally {
      await closeStratosDb(db)
    }
  }

  /**
   * Perform a read operation followed by a transactional operation on an actor with the given DID.
   * @param did - The DID of the actor to perform the operations on.
   * @param readFn - A function that takes an ActorReader and returns a value or Promise.
   * @param transactFn - A function that takes the result of the read operation and an ActorTransactor, and returns a value or Promise.
   * @returns A Promise resolving to the result of the provided transactional function.
   */
  async readThenTransact<R, T>(
    did: string,
    readFn: (store: ActorReader) => R | PromiseLike<R>,
    transactFn: (
      readResult: Awaited<R>,
      store: ActorTransactor,
    ) => T | PromiseLike<T>,
  ): Promise<T> {
    const { dbLocation } = await this.getLocation(did)
    const db = createStratosDb(dbLocation)
    await db._initialized
    const blobStore = this.blobstore(did)

    try {
      const reader: ActorReader = {
        did,
        record: new SqliteActorRecordReader(
          new StratosRecordReader(db, this.cborToRecord, this.logger),
        ),
        repo: new StratosSqlRepoReader(db),
        blob: new StratosBlobReader(db, blobStore, this.logger),
        sequence: new SqliteSequenceOps(db),
      }
      const readResult = await readFn(reader)

      return await db.transaction(async (tx) => {
        const txDb = tx as unknown as StratosDbOrTx
        const transactor: ActorTransactor = {
          did,
          record: new SqliteActorRecordTransactor(
            new StratosRecordTransactor(txDb, this.cborToRecord, this.logger),
          ),
          repo: new StratosSqlRepoTransactor(txDb),
          blob: new StratosBlobTransactor(txDb, blobStore, this.logger),
          sequence: new SqliteSequenceOps(txDb),
        }
        return transactFn(readResult, transactor)
      })
    } finally {
      await closeStratosDb(db)
    }
  }

  /**
   * Get the BlobStore for an actor with the given DID.
   * @param did - The DID of the actor.
   * @returns The BlobStore for the actor.
   */
  getBlobStore(did: string): BlobStore {
    return this.blobstore(did)
  }

  /**
   * Create a signing key for an actor with the given DID.
   * @param did - The DID of the actor.
   * @returns A Promise resolving to the created P256Keypair.
   */
  async createSigningKey(did: string): Promise<crypto.P256Keypair> {
    const { directory } = await this.getLocation(did)
    const keyPath = path.join(directory, 'signing_key')
    const keypair = await crypto.P256Keypair.create({ exportable: true })
    const exported = await (keypair as crypto.ExportableKeypair).export()
    await fs.writeFile(keyPath, exported)
    return keypair
  }

  /**
   * Load the signing key for an actor with the given DID.
   * @param did - The DID of the actor.
   * @returns A Promise resolving to the loaded P256Keypair or null if not found.
   */
  async loadSigningKey(did: string): Promise<crypto.P256Keypair | null> {
    const { directory } = await this.getLocation(did)
    const keyPath = path.join(directory, 'signing_key')
    if (!(await fileExists(keyPath))) {
      return null
    }
    const keyBytes = await fs.readFile(keyPath)
    return crypto.P256Keypair.import(keyBytes, { exportable: true })
  }

  /**
   * Delete the signing key for an actor with the given DID.
   * @param did - The DID of the actor.
   * @returns A Promise resolving when the key is deleted or does not exist.
   */
  async deleteSigningKey(did: string): Promise<void> {
    const { directory } = await this.getLocation(did)
    const keyPath = path.join(directory, 'signing_key')
    try {
      await fs.unlink(keyPath)
    } catch {
      // Key file may not exist
    }
  }

  /**
   * Get the location information for an actor with the given DID.
   * @param did - The DID of the actor.
   * @returns An object containing the directory, database location, and blob location for the actor.
   * @private
   */
  private async getLocation(did: string) {
    const didHash = await crypto.sha256Hex(did)
    const directory = path.join(this.dataDir, didHash.slice(0, 2), did)
    const resolved = path.resolve(directory)
    if (!resolved.startsWith(path.resolve(this.dataDir))) {
      throw new Error('Invalid DID: resolved path escapes data directory')
    }
    const dbLocation = path.join(directory, 'stratos.sqlite')
    const blobLocation = path.join(directory, 'blobs')
    return { directory, dbLocation, blobLocation }
  }
}
