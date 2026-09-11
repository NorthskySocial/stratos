import assert from 'node:assert/strict'
import {
  createDatabase,
  createIdResolver,
  createIndexingService,
} from '../src/storage/db.js'
import type { IndexerConfig } from '../src/config.js'
import { StratosError } from '@northskysocial/stratos-core'

const db = createDatabase({
  postgresUrl: 'postgresql://shinji@localhost/nerv',
  schema: 'nerv',
  poolSize: 1,
})
const idResolver = createIdResolver({ plcUrl: 'https://plc.nerv.jp' })
const { indexingService, background } = createIndexingService(db, idResolver, {
  pds: { repoProvider: 'wss://pds.nerv.jp' },
  worker: { backgroundQueueConcurrency: 1, backgroundQueueMaxSize: 2 },
} as IndexerConfig)
try {
  assert.equal(indexingService.idResolver, idResolver)
  await assert.rejects(
    indexingService.idResolver.did.resolve('did:web:127.0.0.1'),
    (error: unknown) =>
      error instanceof StratosError && error.code === 'UnsafeOutboundAddress',
  )
  let completed = false
  background.add(async (context) => {
    assert.equal(context, db)
    completed = true
  })
  await background.processAll()
  assert.equal(completed, true)
  console.log(
    'Deno indexer SDK checks passed: protected identity and background work',
  )
} finally {
  await background.destroy()
  await db.close()
}
// The production resolver keeps its cache sweep timer running.
Deno.exit(0)
