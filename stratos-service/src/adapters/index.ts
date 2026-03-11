/**
 * Storage Adapters
 *
 * Provides storage implementations for different backends.
 */

// SQLite adapters
export * from './sqlite/index.js'

// PostgreSQL adapters
export * from './postgres/index.js'
// export * from './postgres/index.js'

// Re-export storage interfaces from stratos-core
export type {
  StorageFactory,
  StorageConfig,
  StorageBackend,
  ActorStoreReaders,
  ActorStoreWriters,
  ServiceStores,
} from '@northskysocial/stratos-core'
