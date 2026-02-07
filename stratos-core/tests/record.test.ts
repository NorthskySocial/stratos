import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {mkdir, rm} from 'fs/promises'
import {join} from 'path'
import {tmpdir} from 'os'
import {randomBytes} from 'crypto'
import {CID} from 'multiformats/cid'
import {sha256} from 'multiformats/hashes/sha2'
import {AtUri} from '@atproto/syntax'
import {eq} from 'drizzle-orm'

import {StratosRecordReader, StratosRecordTransactor} from '../src/record/index.js'
import {
  createStratosDb,
  migrateStratosDb,
  closeStratosDb,
  StratosDb,
  stratosRecord,
  stratosBacklink,
} from '../src/db/index.js'

// Simple encoding for tests (just use JSON for simplicity)
const encodeRecord = (data: unknown): Buffer => {
  return Buffer.from(new TextEncoder().encode(JSON.stringify(data)))
}

const decodeRecord = (content: Buffer): Record<string, unknown> => {
  return JSON.parse(new TextDecoder().decode(content))
}

// Create a deterministic CID from data
const createCid = async (data: unknown): Promise<CID> => {
  const bytes = encodeRecord(data)
  const hash = await sha256.digest(bytes)
  return CID.createV1(0x55, hash) // 0x55 = raw codec
}

describe('Record Reader', () => {
  let db: StratosDb
  let reader: StratosRecordReader
  let testDir: string
  let dbPath: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `stratos-record-test-${randomBytes(8).toString('hex')}`)
    await mkdir(testDir, {recursive: true})
    dbPath = join(testDir, 'test.db')

    db = createStratosDb(dbPath)
    await migrateStratosDb(db)
    reader = new StratosRecordReader(db, decodeRecord)
  })

  afterEach(async () => {
    await closeStratosDb(db)
    await rm(testDir, {recursive: true, force: true})
  })

  describe('recordCount', () => {
    it('should return 0 for empty database', async () => {
      const count = await reader.recordCount()
      expect(count).toBe(0)
    })

    it('should return correct count after inserts', async () => {
      // Insert some records
      await db.insert(stratosRecord).values([
        {
          uri: 'at://did:plc:test/app.stratos.feed.post/1111111111111',
          cid: 'bafyreiabc123',
          collection: 'app.stratos.feed.post',
          rkey: '1111111111111',
          repoRev: 'rev1',
          indexedAt: new Date().toISOString(),
          takedownRef: null,
        },
        {
          uri: 'at://did:plc:test/app.stratos.feed.post/2222222222222',
          cid: 'bafyreiabc456',
          collection: 'app.stratos.feed.post',
          rkey: '2222222222222',
          repoRev: 'rev2',
          indexedAt: new Date().toISOString(),
          takedownRef: null,
        },
      ])

      const count = await reader.recordCount()
      expect(count).toBe(2)
    })
  })

  describe('listCollections', () => {
    it('should return empty array for no records', async () => {
      const collections = await reader.listCollections()
      expect(collections).toEqual([])
    })

    it('should return unique collections', async () => {
      await db.insert(stratosRecord).values([
        {
          uri: 'at://did:plc:test/app.stratos.feed.post/1',
          cid: 'cid1',
          collection: 'app.stratos.feed.post',
          rkey: '1',
          repoRev: 'rev1',
          indexedAt: new Date().toISOString(),
          takedownRef: null,
        },
        {
          uri: 'at://did:plc:test/app.stratos.feed.post/2',
          cid: 'cid2',
          collection: 'app.stratos.feed.post',
          rkey: '2',
          repoRev: 'rev2',
          indexedAt: new Date().toISOString(),
          takedownRef: null,
        },
        {
          uri: 'at://did:plc:test/app.stratos.graph.follow/1',
          cid: 'cid3',
          collection: 'app.stratos.graph.follow',
          rkey: '1',
          repoRev: 'rev3',
          indexedAt: new Date().toISOString(),
          takedownRef: null,
        },
      ])

      const collections = await reader.listCollections()
      expect(collections).toHaveLength(2)
      expect(collections).toContain('app.stratos.feed.post')
      expect(collections).toContain('app.stratos.graph.follow')
    })
  })
})

describe('Record Transactor', () => {
  let db: StratosDb
  let transactor: StratosRecordTransactor
  let testDir: string
  let dbPath: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `stratos-transact-test-${randomBytes(8).toString('hex')}`)
    await mkdir(testDir, {recursive: true})
    dbPath = join(testDir, 'test.db')

    db = createStratosDb(dbPath)
    await migrateStratosDb(db)
    transactor = new StratosRecordTransactor(db, decodeRecord)
  })

  afterEach(async () => {
    await closeStratosDb(db)
    await rm(testDir, {recursive: true, force: true})
  })

  describe('indexRecord', () => {
    it('should index a new record', async () => {
      const uri = new AtUri('at://did:plc:test/app.stratos.feed.post/3jqfcqzm3fv2p')
      const cid = await createCid({text: 'Hello'})
      const record = {text: 'Hello', createdAt: new Date().toISOString()}

      await transactor.indexRecord(uri, cid, record, 'create', 'rev1')

      const count = await transactor.recordCount()
      expect(count).toBe(1)

      const records = await transactor.listAll()
      expect(records).toHaveLength(1)
      expect(records[0].uri).toBe(uri.toString())
      expect(records[0].cid.toString()).toBe(cid.toString())
    })

    it('should update existing record on conflict', async () => {
      const uri = new AtUri('at://did:plc:test/app.stratos.feed.post/testkey')
      const cid1 = await createCid({text: 'Original'})
      const cid2 = await createCid({text: 'Updated'})

      // Create initial record
      await transactor.indexRecord(
        uri,
        cid1,
        {text: 'Original'},
        'create',
        'rev1',
      )

      // Update the record
      await transactor.indexRecord(
        uri,
        cid2,
        {text: 'Updated'},
        'update',
        'rev2',
      )

      const count = await transactor.recordCount()
      expect(count).toBe(1)

      const records = await transactor.listAll()
      expect(records[0].cid.toString()).toBe(cid2.toString())
    })

    it('should reject URI without DID', async () => {
      const uri = new AtUri('at://handle.example.com/app.stratos.feed.post/1')
      const cid = await createCid({text: 'Test'})

      await expect(
        transactor.indexRecord(uri, cid, {text: 'Test'}, 'create', 'rev1'),
      ).rejects.toThrow('Expected indexed URI to contain DID')
    })
  })

  describe('deleteRecord', () => {
    it('should delete an existing record', async () => {
      const uri = new AtUri('at://did:plc:test/app.stratos.feed.post/todelete')
      const cid = await createCid({text: 'Delete me'})

      await transactor.indexRecord(uri, cid, {text: 'Delete me'}, 'create', 'rev1')
      expect(await transactor.recordCount()).toBe(1)

      await transactor.deleteRecord(uri)
      expect(await transactor.recordCount()).toBe(0)
    })

    it('should delete associated backlinks', async () => {
      const uri = new AtUri('at://did:plc:test/app.stratos.graph.follow/1')
      const cid = await createCid({
        subject: 'did:plc:followed',
        createdAt: new Date().toISOString(),
      })

      await transactor.indexRecord(
        uri,
        cid,
        {subject: 'did:plc:followed', createdAt: new Date().toISOString()},
        'create',
        'rev1',
      )

      // Add a backlink manually
      await transactor.addBacklinks([
        {
          uri: uri.toString(),
          path: 'subject',
          linkTo: 'did:plc:followed',
        },
      ])

      // Verify backlink exists
      const backlinksBefore = await db
        .select()
        .from(stratosBacklink)
      expect(backlinksBefore).toHaveLength(1)

      // Delete record
      await transactor.deleteRecord(uri)

      // Verify backlink removed
      const backlinksAfter = await db
        .select()
        .from(stratosBacklink)
      expect(backlinksAfter).toHaveLength(0)
    })
  })

  describe('updateRecordTakedown', () => {
    it('should apply takedown to record', async () => {
      const uri = new AtUri('at://did:plc:test/app.stratos.feed.post/badcontent')
      const cid = await createCid({text: 'Bad content'})

      await transactor.indexRecord(uri, cid, {text: 'Bad content'}, 'create', 'rev1')

      await transactor.updateRecordTakedown(uri, {applied: true, ref: 'TAKEDOWN-123'})

      const records = await db
        .select()
        .from(stratosRecord)
        .where(eq(stratosRecord.uri, uri.toString()))
        .limit(1)
      const record = records[0]

      expect(record?.takedownRef).toBe('TAKEDOWN-123')
    })

    it('should remove takedown from record', async () => {
      const uri = new AtUri('at://did:plc:test/app.stratos.feed.post/restored')
      const cid = await createCid({text: 'Restored content'})

      await transactor.indexRecord(uri, cid, {text: 'Restored'}, 'create', 'rev1')
      await transactor.updateRecordTakedown(uri, {applied: true, ref: 'TD-456'})

      // Now remove takedown
      await transactor.updateRecordTakedown(uri, {applied: false})

      const records = await db
        .select()
        .from(stratosRecord)
        .where(eq(stratosRecord.uri, uri.toString()))
        .limit(1)
      const record = records[0]

      expect(record?.takedownRef).toBeNull()
    })
  })

  describe('backlinks', () => {
    it('should add backlinks', async () => {
      await transactor.addBacklinks([
        {
          uri: 'at://did:plc:test/app.stratos.graph.follow/1',
          path: 'subject',
          linkTo: 'did:plc:followed',
        },
        {
          uri: 'at://did:plc:test/app.stratos.feed.post/1',
          path: 'reply.parent',
          linkTo: 'at://did:plc:other/app.stratos.feed.post/2',
        },
      ])

      const backlinks = await db
        .select()
        .from(stratosBacklink)

      expect(backlinks).toHaveLength(2)
    })

    it('should remove backlinks by URI', async () => {
      const uri = 'at://did:plc:test/app.stratos.graph.follow/1'

      await transactor.addBacklinks([
        {uri, path: 'subject', linkTo: 'did:plc:a'},
        {uri, path: 'other', linkTo: 'did:plc:b'},
      ])

      expect(
        await db.select().from(stratosBacklink),
      ).toHaveLength(2)

      await transactor.removeBacklinksByUri(new AtUri(uri))

      expect(
        await db.select().from(stratosBacklink),
      ).toHaveLength(0)
    })

    it('should not duplicate backlinks on conflict', async () => {
      const backlink = {
        uri: 'at://did:plc:test/app.stratos.graph.follow/1',
        path: 'subject',
        linkTo: 'did:plc:followed',
      }

      await transactor.addBacklinks([backlink])
      await transactor.addBacklinks([backlink]) // Same again

      const backlinks = await db
        .select()
        .from(stratosBacklink)

      expect(backlinks).toHaveLength(1)
    })
  })
})
