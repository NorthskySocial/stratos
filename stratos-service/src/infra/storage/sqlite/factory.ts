/**
 * SQLite Storage Factory
 *
 * Creates SQLite-based storage adapters following the per-actor database pattern.
 * Each actor gets their own SQLite database file.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from '@atproto/crypto'
import type {
  ActorStoreReaders,
  ActorStoreWriters,
  BlobContentStore,
  ServiceStores,
  StorageBackend,
  StorageFactory,
} from '@northskysocial/stratos-core'
import {
  closeStratosDb,
  createStratosDb,
  migrateStratosDb,
  type StratosDb,
} from '@northskysocial/stratos-core'
import {
  SqliteRecordStoreReader,
  SqliteRecordStoreWriter,
} from './record-store.js'
import {
  SqliteBlobMetadataReader,
  SqliteBlobMetadataWriter,
} from './blob-store.js'
import { SqliteRepoStoreReader, SqliteRepoStoreWriter } from './repo-store.js'
import {
  SqliteSequenceStoreReader,
  SqliteSequenceStoreWriter,
} from './sequence-store.js'
import { SqliteEnrollmentStoreWriter } from './enrollment-store.js'
import { ServiceDb } from '../../../db/index.js'

/**
 * Check if a file exists
 */
async function fileExists(filepath: string): Promise<boolean> {
  try {
    await fs.access(filepath)
    return true
  } catch {
    return false
  }
}

/**
 * Configuration for SQLite storage factory
 */
export interface SqliteStorageFactoryConfig {
  /** Directory for actor databases */
  dataDir: string
  /** Service-level database */
  serviceDb: ServiceDb
  /** CBOR decoder function */
  cborToRecord: (content: Uint8Array) => Record<string, unknown>
  /** Blob content store creator (for filesystem/S3 storage) */
  blobContentStoreCreator: (did: string) => BlobContentStore
}

/**
 * SQLite implementation of StorageFactory
 */
export class SqliteStorageFactory implements StorageFactory {
  readonly backend: StorageBackend = 'sqlite'

  private readonly dataDir: string
  private readonly serviceDb: ServiceDb
  private readonly cborToRecord: (
    content: Uint8Array,
  ) => Record<string, unknown>
  private readonly blobContentStoreCreator: (did: string) => BlobContentStore

  constructor(config: SqliteStorageFactoryConfig) {
    this.dataDir = config.dataDir
    this.serviceDb = config.serviceDb
    this.cborToRecord = config.cborToRecord
    this.blobContentStoreCreator = config.blobContentStoreCreator
  }

  /**
   * Initialize the factory, ensuring the data directory exists.
   */
  async initialize(): Promise<void> {
    // Ensure data directory exists
    await fs.mkdir(this.dataDir, { recursive: true })
  }

  /**
   * Check if an actor exists by verifying the existence of its database file.
   * @param did - The DID of the actor to check.
   * @returns True if the actor exists, false otherwise.
   */
  async actorExists(did: string): Promise<boolean> {
    const { dbLocation } = await this.getActorLocation(did)
    return fileExists(dbLocation)
  }

  /**
   * Create a new actor by creating a new database file.
   * @param did - The DID of the actor to create.
   * @returns A promise that resolves when the actor is created.
   */
  async createActor(did: string): Promise<void> {
    const { directory, dbLocation } = await this.getActorLocation(did)

    // Create directory
    await fs.mkdir(directory, { recursive: true })

    // Create and migrate database
    const db = createStratosDb(dbLocation)
    try {
      await db._initialized
      await migrateStratosDb(db)
    } finally {
      await closeStratosDb(db)
    }
  }

  /**
   * Delete an actor by removing its database file and associated directory.
   * @param did - The DID of the actor to delete.
   */
  async deleteActor(did: string): Promise<void> {
    const { directory } = await this.getActorLocation(did)
    await fs.rm(directory, { recursive: true, force: true })
  }

  /**
   * Get the readers for an actor's stores.'
   * @param did - The DID of the actor
   * @returns The Actor Store Readers
   */
  async getActorReaders(did: string): Promise<ActorStoreReaders> {
    const { dbLocation } = await this.getActorLocation(did)
    const db = createStratosDb(dbLocation)
    await db._initialized

    return {
      record: new SqliteRecordStoreReader(db, this.cborToRecord),
      blobMetadata: new SqliteBlobMetadataReader(db),
      blobContent: this.blobContentStoreCreator(did),
      repo: new SqliteRepoStoreReader(db),
      sequence: new SqliteSequenceStoreReader(db),
    }
  }

  /**
   * Execute a transactional operation on an actor's stores.
   * @param did - The DID of the actor.
   * @param fn - The transactional function to execute.
   * @returns A promise that resolves with the result of the transactional function.
   */
  async transactActor<T>(
    did: string,
    fn: (stores: ActorStoreWriters) => Promise<T>,
  ): Promise<T> {
    const { dbLocation } = await this.getActorLocation(did)
    const db = createStratosDb(dbLocation)
    await db._initialized

    try {
      return await db.transaction(async (tx) => {
        const stores: ActorStoreWriters = {
          record: new SqliteRecordStoreWriter(
            tx as unknown as StratosDb,
            this.cborToRecord,
          ),
          blobMetadata: new SqliteBlobMetadataWriter(
            tx as unknown as StratosDb,
          ),
          blobContent: this.blobContentStoreCreator(did),
          repo: new SqliteRepoStoreWriter(tx as unknown as StratosDb),
          sequence: new SqliteSequenceStoreWriter(tx as unknown as StratosDb),
        }
        return await fn(stores)
      })
    } finally {
      await closeStratosDb(db)
    }
  }

  /**
   * Get the service-level stores.
   * @returns The Service Stores
   */
  getServiceStores(): ServiceStores {
    return {
      enrollment: new SqliteEnrollmentStoreWriter(this.serviceDb),
    }
  }

  /**
   * Close the SQLite factory, releasing any resources.
   * There is nothing to close for SQLite factory - connections are opened/closed per operation.
   */
  async close(): Promise<void> {
    // Nothing to close for SQLite factory - connections are opened/closed per operation
  }

  /**
   * Get the database location for an actor
   */
  private async getActorLocation(did: string): Promise<{
    directory: string
    dbLocation: string
  }> {
    const didHash = await crypto.sha256Hex(did)
    const directory = path.join(this.dataDir, didHash.slice(0, 2), did)
    const dbLocation = path.join(directory, 'stratos.sqlite')
    return { directory, dbLocation }
  }
}
