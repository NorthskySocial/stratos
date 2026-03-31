export * from './pg-tables.js'

import {
  pgStratosBacklink,
  pgStratosBlob,
  pgStratosRecord,
  pgStratosRecordBlob,
  pgStratosRepoBlock,
  pgStratosRepoRoot,
  pgStratosSeq,
  pgStratosSigningKey,
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
