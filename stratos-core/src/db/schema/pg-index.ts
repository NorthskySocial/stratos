export * from './pg-tables.js'

import {
  pgStratosBacklink,
  pgStratosBlob,
  pgStratosRecord,
  pgStratosRecordBlob,
  pgStratosRecordBoundary,
  pgStratosRepoBlock,
  pgStratosRepoRoot,
  pgStratosSeq,
  pgStratosSigningKey,
} from './pg-tables.js'

export const pgSchema = {
  pgStratosRepoRoot,
  pgStratosRepoBlock,
  pgStratosRecord,
  pgStratosRecordBoundary,
  pgStratosBlob,
  pgStratosRecordBlob,
  pgStratosBacklink,
  pgStratosSigningKey,
  pgStratosSeq,
}
