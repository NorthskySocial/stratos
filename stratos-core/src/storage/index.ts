/**
 * Storage interfaces for backend abstraction
 *
 * These interfaces define the contract for storage operations,
 * allowing different backends (SQLite, PostgreSQL, etc.) to be swapped.
 */

export * from './record-store.js'
export * from './blob-store.js'
export * from './repo-store.js'
export * from './enrollment-store.js'
export * from './sequence-store.js'
export * from './cache.js'

import type { RecordStoreReader, RecordStoreWriter } from './record-store.js'
import type {
  BlobMetadataReader,
  BlobMetadataWriter,
  BlobContentStore,
} from './blob-store.js'
import type { RepoStoreReader, RepoStoreWriter } from './repo-store.js'
import type { EnrollmentStoreWriter } from './enrollment-store.js'
import type {
  SequenceStoreReader,
  SequenceStoreWriter,
} from './sequence-store.js'

/**
 * Combined reader interfaces for an actor's data
 */
export interface ActorStoreReaders {
  record: RecordStoreReader
  blobMetadata: BlobMetadataReader
  blobContent: BlobContentStore
  repo: RepoStoreReader
  sequence: SequenceStoreReader
}

/**
 * Combined writer interfaces for an actor's data
 */
export interface ActorStoreWriters {
  record: RecordStoreWriter
  blobMetadata: BlobMetadataWriter
  blobContent: BlobContentStore
  repo: RepoStoreWriter
  sequence: SequenceStoreWriter
}

/**
 * Service-level stores (not per-actor)
 */
export interface ServiceStores {
  enrollment: EnrollmentStoreWriter
}

/**
 * Storage backend type
 */
export type StorageBackend = 'sqlite' | 'postgres'

/**
 * Configuration for storage factory
 */
export interface StorageConfig {
  backend: StorageBackend
  sqlite?: {
    dataDir: string
  }
  postgres?: {
    connectionString: string
    /** Whether to use separate schemas per actor (recommended for isolation) */
    perActorSchema?: boolean
  }
}

/**
 * Factory interface for creating storage instances
 *
 * This is the main entry point for storage operations.
 * Implementations provide backend-specific behavior.
 */
export interface StorageFactory {
  /** The backend type this factory uses */
  readonly backend: StorageBackend

  /** Initialize storage (run migrations, etc.) */
  initialize(): Promise<void>

  /** Check if an actor's storage exists */
  actorExists(did: string): Promise<boolean>

  /** Create storage for a new actor */
  createActor(did: string): Promise<void>

  /** Delete an actor's storage */
  deleteActor(did: string): Promise<void>

  /** Get readers for an actor's data */
  getActorReaders(did: string): Promise<ActorStoreReaders>

  /** Execute a function within a transaction for an actor */
  transactActor<T>(
    did: string,
    fn: (stores: ActorStoreWriters) => Promise<T>,
  ): Promise<T>

  /** Get service-level stores */
  getServiceStores(): ServiceStores

  /** Close all connections */
  close(): Promise<void>
}
