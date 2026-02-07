// Re-export all schema tables and types
export * from './tables.js'

import {
  stratosRepoRoot,
  stratosRepoBlock,
  stratosRecord,
  stratosBlob,
  stratosRecordBlob,
  stratosBacklink,
  stratosSeq,
} from './tables.js'

/**
 * All schema tables for use with Drizzle
 */
export const schema = {
  stratosRepoRoot,
  stratosRepoBlock,
  stratosRecord,
  stratosBlob,
  stratosRecordBlob,
  stratosBacklink,
  stratosSeq,
}

