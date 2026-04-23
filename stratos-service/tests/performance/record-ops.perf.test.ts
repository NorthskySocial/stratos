import { afterAll, beforeAll, describe, it } from 'vitest'
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

describe('Performance: Record Operations', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  const testDid = 'did:plc:shinji-ikari'
  const boundary = 'did:web:nerv.tokyo.jp/engineering'

  async function createTestCid(data: any) {
    const bytes = encodeRecord(data)
    const hash = await sha256.digest(bytes)
    return CID.createV1(0x55, hash)
  }

  beforeAll(async () => {
    dataDir = join(tmpdir(), `stratos-perf-${randomBytes(8).toString('hex')}`)
    await mkdir(dataDir, { recursive: true })

    actorStore = new StratosActorStore({
      dataDir,
      blobstore: () => createMockBlobStore(),
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })

    await actorStore.create(testDid)
  })

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('measures record creation throughput (1000 records)', async () => {
    const count = 1000
    const start = performance.now()

    await actorStore.transact(testDid, async (store) => {
      for (let i = 0; i < count; i++) {
        const record = {
          $type: 'app.bsky.feed.post',
          text: `Hello from Evangelion Unit-01, message ${i}`,
          createdAt: new Date().toISOString(),
          boundary: {
            $type: 'zone.stratos.boundary.defs#Domains',
            values: [{ value: boundary }],
          },
        }
        const cid = await createTestCid(record)
        await store.record.putRecord({
          uri: `at://${testDid}/app.bsky.feed.post/perf-${i}`,
          cid,
          value: record,
          content: encodeRecord(record),
        })
      }
    })

    const end = performance.now()
    const duration = end - start
    console.log(
      `[PERF] Created ${count} records in ${duration.toFixed(2)}ms (${(count / (duration / 1000)).toFixed(2)} rec/sec)`,
    )
  })

  it('measures record retrieval latency (1000 records)', async () => {
    const count = 1000
    const start = performance.now()

    await actorStore.read(testDid, async (store) => {
      for (let i = 0; i < count; i++) {
        const uri = `at://${testDid}/app.bsky.feed.post/perf-${i}`
        const record = await store.record.getRecord(uri, null)
        if (!record) throw new Error(`Record ${uri} not found`)
      }
    })

    const end = performance.now()
    const duration = end - start
    console.log(
      `[PERF] Retrieved ${count} records in ${duration.toFixed(2)}ms (${(duration / count).toFixed(4)}ms/rec)`,
    )
  })
})
