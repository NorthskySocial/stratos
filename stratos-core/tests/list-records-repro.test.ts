import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { CID, Cid } from '@atproto/lex-data'
import { sha256 } from 'multiformats/hashes/sha2'
import { AtUri } from '@atproto/syntax'

import {
  closeStratosDb,
  createStratosDb,
  migrateStratosDb,
  StratosDb,
  StratosRecordReader,
  StratosRecordTransactor,
} from '../src/index.js'

// Simple encoding for tests (just use JSON for simplicity)
const encodeRecord = (data: unknown): Uint8Array => {
  return new TextEncoder().encode(JSON.stringify(data))
}

const decodeRecord = (content: Uint8Array): Record<string, unknown> => {
  return JSON.parse(new TextDecoder().decode(content)) as Record<
    string,
    unknown
  >
}

// Create a deterministic CID from data
const createCid = async (data: unknown): Promise<Cid> => {
  const bytes = encodeRecord(data)
  const hash = await sha256.digest(bytes)
  return CID.createV1(0x55, hash) // 0x55 = raw codec
}

describe('List Records Repro', () => {
  let db: StratosDb
  let reader: StratosRecordReader
  let transactor: StratosRecordTransactor
  let testDir: string
  let dbPath: string

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-list-repro-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })
    dbPath = join(testDir, 'test.db')

    db = createStratosDb(dbPath)
    await migrateStratosDb(db)
    reader = new StratosRecordReader(db, decodeRecord)
    transactor = new StratosRecordTransactor(db, decodeRecord)
  })

  afterEach(async () => {
    await closeStratosDb(db)
    await rm(testDir, { recursive: true, force: true })
  })

  it('should list records with rkey cursor', async () => {
    const collection = 'zone.stratos.feed.post'
    const records = [
      { rkey: 'a', text: 'post A' },
      { rkey: 'b', text: 'post B' },
      { rkey: 'c', text: 'post C' },
    ]

    for (const r of records) {
      const uri = `at://did:plc:test/${collection}/${r.rkey}`
      const value = { text: r.text, createdAt: new Date().toISOString() }
      const cid = await createCid(value)
      await transactor.putRecord({
        uri,
        cid,
        value,
        content: encodeRecord(value),
      })
    }

    // Test with rkey cursor
    const res = await reader.listRecordsForCollection({
      collection,
      limit: 2,
      reverse: false,
      cursor: 'a',
    })

    expect(res).toHaveLength(2)
    expect(res[0].uri).toContain('/b')
    expect(res[1].uri).toContain('/c')
  })

  it('should list records with AtUri cursor', async () => {
    const collection = 'zone.stratos.feed.post'
    const records = [
      { rkey: 'a', text: 'post A' },
      { rkey: 'b', text: 'post B' },
      { rkey: 'c', text: 'post C' },
    ]

    for (const r of records) {
      const uri = `at://did:plc:test/${collection}/${r.rkey}`
      const value = { text: r.text, createdAt: new Date().toISOString() }
      const cid = await createCid(value)
      await transactor.putRecord({
        uri,
        cid,
        value,
        content: encodeRecord(value),
      })
    }

    // Test with AtUri cursor
    const res = await reader.listRecordsForCollection({
      collection,
      limit: 2,
      reverse: false,
      cursor: 'at://did:plc:test/zone.stratos.feed.post/a',
    })

    expect(res).toHaveLength(2)
    expect(res[0].uri).toContain('/b')
    expect(res[1].uri).toContain('/c')
  })

  it('should handle reverse correctly', async () => {
    const collection = 'zone.stratos.feed.post'
    const records = [
      { rkey: 'a', text: 'post A' },
      { rkey: 'b', text: 'post B' },
      { rkey: 'c', text: 'post C' },
    ]

    for (const r of records) {
      const uri = `at://did:plc:test/${collection}/${r.rkey}`
      const value = { text: r.text, createdAt: new Date().toISOString() }
      const cid = await createCid(value)
      await transactor.putRecord({
        uri,
        cid,
        value,
        content: encodeRecord(value),
      })
    }

    // Default (reverse: false) should be ascending
    const ascRes = await reader.listRecordsForCollection({
      collection,
      limit: 10,
      reverse: false,
    })
    expect(ascRes[0].uri).toContain('/a')
    expect(ascRes[2].uri).toContain('/c')

    // Reverse: true should be descending
    const descRes = await reader.listRecordsForCollection({
      collection,
      limit: 10,
      reverse: true,
    })
    expect(descRes[0].uri).toContain('/c')
    expect(descRes[2].uri).toContain('/a')

    // Reverse with cursor
    const descCursorRes = await reader.listRecordsForCollection({
      collection,
      limit: 10,
      reverse: true,
      cursor: 'c',
    })
    expect(descCursorRes).toHaveLength(2)
    expect(descCursorRes[0].uri).toContain('/b')
    expect(descCursorRes[1].uri).toContain('/a')
  })
})
