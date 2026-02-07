/**
 * Storage Adapters
 *
 * Provides storage implementations for different backends.
 */

// SQLite adapters
export * from './sqlite/index.js'

// PostgreSQL adapters (to be implemented)
// export * from './postgres/index.js'

// Re-export storage interfaces from stratos-core
export type {
  StorageFactory,
  StorageConfig,
  StorageBackend,
  ActorStoreReaders,
  ActorStoreWriters,
  ServiceStores,
} from '@northsky/stratos-core'
