import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { CID } from '@atproto/lex-data'
import { sha256 } from 'multiformats/hashes/sha2'
import { StratosActorStore } from '../../src/context.js'
import { createMockBlobStore } from '../utils'
import { decode } from '@atcute/cbor'
import { encodeRecord } from '@northskysocial/stratos-core'
import {
  ActorStoreRecordResolver,
  HydrationServiceImpl,
} from '../../src/features/hydration/adapter.js'

describe('Performance: Hydration', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let hydrationService: HydrationServiceImpl
  const testDid = 'did:plc:asuka-langley'
  const boundary = 'did:web:nerv.tokyo.jp/pilot'
  const recordCount = 500

  async function createTestCid(data: any) {
    const bytes = encodeRecord(data)
    const hash = await sha256.digest(bytes)
    return CID.createV1(0x55, hash)
  }

  beforeAll(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-hydration-perf-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })

    actorStore = new StratosActorStore({
      dataDir,
      blobstore: () => createMockBlobStore(),
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })

    const recordResolver = new ActorStoreRecordResolver(actorStore)
    const boundaryResolver = {
      getBoundaries: vi.fn().mockResolvedValue([boundary]),
    }
    hydrationService = new HydrationServiceImpl(
      recordResolver,
      boundaryResolver,
    )

    await actorStore.create(testDid)
    await actorStore.transact(testDid, async (store) => {
      for (let i = 0; i < recordCount; i++) {
        const record = {
          $type: 'zone.stratos.feed.post',
          text: `Evangelion Unit-02 is active, message ${i}`,
          createdAt: new Date().toISOString(),
          boundary: {
            $type: 'zone.stratos.boundary.defs#Domains',
            values: [{ value: boundary }],
          },
        }
        const cid = await createTestCid(record)
        await store.record.putRecord({
          uri: `at://${testDid}/zone.stratos.feed.post/perf-${i}`,
          cid,
          value: record,
          content: encodeRecord(record),
        })
      }
    })
  })

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('measures batch hydration performance (100 records)', async () => {
    const batchSize = 100
    const requests = Array.from({ length: batchSize }, (_, i) => ({
      uri: `at://${testDid}/zone.stratos.feed.post/perf-${i}`,
    }))

    const start = performance.now()
    const result = await hydrationService.hydrateRecords(requests, {
      viewerDid: 'did:plc:viewer',
      viewerDomains: [boundary],
    })
    const end = performance.now()

    const duration = end - start
    console.log(
      `[PERF] Hydrated batch of ${batchSize} records in ${duration.toFixed(2)}ms (${(duration / batchSize).toFixed(4)}ms/rec)`,
    )
    if (result.records.length !== batchSize) {
      throw new Error(
        `Expected ${batchSize} records, got ${result.records.length}`,
      )
    }
  })

  it('measures single record hydration performance (repeated 100 times)', async () => {
    const iterations = 100
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      await hydrationService.hydrateRecord(
        { uri: `at://${testDid}/zone.stratos.feed.post/perf-${i}` },
        {
          viewerDid: 'did:plc:viewer',
          viewerDomains: [boundary],
        },
      )
    }
    const end = performance.now()

    const duration = end - start
    console.log(
      `[PERF] Hydrated ${iterations} single records in ${duration.toFixed(2)}ms (${(duration / iterations).toFixed(4)}ms/rec)`,
    )
  })
})
