export * from './pg-tables.js'

import {
  pgStratosRepoRoot,
  pgStratosRepoBlock,
  pgStratosRecord,
  pgStratosBlob,
  pgStratosRecordBlob,
  pgStratosBacklink,
  pgStratosSigningKey,
  pgStratosSeq,
} from './pg-tables.js'

export const pgSchema = {
  pgStratosRepoRoot,
  pgStratosRepoBlock,
  pgStratosRecord,
  pgStratosBlob,
  pgStratosRecordBlob,
  pgStratosBacklink,
  pgStratosSigningKey,
  pgStratosSeq,
}
