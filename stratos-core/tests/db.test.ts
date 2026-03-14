import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sql, eq } from 'drizzle-orm'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  createStratosDb,
  migrateStratosDb,
  closeStratosDb,
  StratosDb,
  stratosRepoRoot,
  stratosRepoBlock,
  stratosRecord,
  stratosBlob,
  stratosBacklink,
  stratosSeq,
} from '../src'

describe('stratos-db', () => {
  let db: StratosDb
  let tempDir: string
  let dbPath: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stratos-test-'))
    dbPath = path.join(tempDir, 'test.sqlite')
    db = createStratosDb(dbPath)
    await migrateStratosDb(db)
  })

  afterEach(async () => {
    await closeStratosDb(db)
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('migrations', () => {
    it('should create all required tables', async () => {
      // Query sqlite_master for table names
      const tables = await db.all<{ name: string }>(sql`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `)

      const tableNames = tables.map((r) => r.name).sort()

      expect(tableNames).toContain('stratos_repo_root')
      expect(tableNames).toContain('stratos_repo_block')
      expect(tableNames).toContain('stratos_record')
      expect(tableNames).toContain('stratos_blob')
      expect(tableNames).toContain('stratos_record_blob')
      expect(tableNames).toContain('stratos_backlink')
      expect(tableNames).toContain('stratos_seq')
    })

    it('should create stratos_record with correct columns', async () => {
      const columns = await db.all<{ name: string; type: string }>(sql`
        PRAGMA table_info(stratos_record)
      `)

      const columnNames = columns.map((r) => r.name)

      expect(columnNames).toContain('uri')
      expect(columnNames).toContain('cid')
      expect(columnNames).toContain('collection')
      expect(columnNames).toContain('rkey')
      expect(columnNames).toContain('repoRev')
      expect(columnNames).toContain('indexedAt')
      expect(columnNames).toContain('takedownRef')
    })

    it('should create stratos_seq with autoincrement', async () => {
      // Insert a sequence entry
      const now = new Date().toISOString()
      await db.insert(stratosSeq).values({
        did: 'did:plc:test',
        eventType: 'append',
        event: Buffer.from(
          new TextEncoder().encode(JSON.stringify({ action: 'create' })),
        ),
        invalidated: 0,
        sequencedAt: now,
      })

      // Insert another
      await db.insert(stratosSeq).values({
        did: 'did:plc:test',
        eventType: 'append',
        event: Buffer.from(
          new TextEncoder().encode(JSON.stringify({ action: 'update' })),
        ),
        invalidated: 0,
        sequencedAt: now,
      })

      // Check auto-increment worked
      const rows = await db.select().from(stratosSeq).orderBy(stratosSeq.seq)

      expect(rows).toHaveLength(2)
      expect(rows[0].seq).toBe(1)
      expect(rows[1].seq).toBe(2)
    })
  })

  describe('stratos_record operations', () => {
    it('should insert and retrieve a record', async () => {
      const now = new Date().toISOString()
      const uri = 'at://did:plc:test/zone.stratos.feed.post/123'

      await db.insert(stratosRecord).values({
        uri,
        cid: 'bafytest123',
        collection: 'zone.stratos.feed.post',
        rkey: '123',
        repoRev: 'rev1',
        indexedAt: now,
        takedownRef: null,
      })

      const rows = await db
        .select()
        .from(stratosRecord)
        .where(eq(stratosRecord.uri, uri))
      const retrieved = rows[0]

      expect(retrieved).toBeDefined()
      expect(retrieved?.cid).toBe('bafytest123')
      expect(retrieved?.collection).toBe('zone.stratos.feed.post')
    })

    it('should update a record', async () => {
      const now = new Date().toISOString()
      const uri = 'at://did:plc:test/zone.stratos.feed.post/123'

      await db.insert(stratosRecord).values({
        uri,
        cid: 'bafyold',
        collection: 'zone.stratos.feed.post',
        rkey: '123',
        repoRev: 'rev1',
        indexedAt: now,
        takedownRef: null,
      })

      await db
        .update(stratosRecord)
        .set({ cid: 'bafynew', repoRev: 'rev2' })
        .where(eq(stratosRecord.uri, uri))

      const rows = await db
        .select()
        .from(stratosRecord)
        .where(eq(stratosRecord.uri, uri))
      const updated = rows[0]

      expect(updated?.cid).toBe('bafynew')
      expect(updated?.repoRev).toBe('rev2')
    })

    it('should delete a record', async () => {
      const now = new Date().toISOString()
      const uri = 'at://did:plc:test/zone.stratos.feed.post/123'

      await db.insert(stratosRecord).values({
        uri,
        cid: 'bafytest',
        collection: 'zone.stratos.feed.post',
        rkey: '123',
        repoRev: 'rev1',
        indexedAt: now,
        takedownRef: null,
      })

      await db.delete(stratosRecord).where(eq(stratosRecord.uri, uri))

      const rows = await db
        .select()
        .from(stratosRecord)
        .where(eq(stratosRecord.uri, uri))

      expect(rows.length).toBe(0)
    })

    it('should enforce unique uri constraint', async () => {
      const now = new Date().toISOString()
      const uri = 'at://did:plc:test/zone.stratos.feed.post/123'

      await db.insert(stratosRecord).values({
        uri,
        cid: 'bafyfirst',
        collection: 'zone.stratos.feed.post',
        rkey: '123',
        repoRev: 'rev1',
        indexedAt: now,
        takedownRef: null,
      })

      await expect(
        db.insert(stratosRecord).values({
          uri,
          cid: 'bafysecond',
          collection: 'zone.stratos.feed.post',
          rkey: '123',
          repoRev: 'rev2',
          indexedAt: now,
          takedownRef: null,
        }),
      ).rejects.toThrow()
    })
  })

  describe('stratos_blob operations', () => {
    it('should insert and retrieve a blob', async () => {
      const cid = 'bafyblob123'
      const now = new Date().toISOString()

      await db.insert(stratosBlob).values({
        cid,
        mimeType: 'image/jpeg',
        size: 12345,
        createdAt: now,
        takedownRef: null,
      })

      const rows = await db
        .select()
        .from(stratosBlob)
        .where(eq(stratosBlob.cid, cid))
      const retrieved = rows[0]

      expect(retrieved).toBeDefined()
      expect(retrieved?.mimeType).toBe('image/jpeg')
      expect(retrieved?.size).toBe(12345)
    })
  })

  describe('stratos_backlink operations', () => {
    it('should insert and query backlinks', async () => {
      const uri = 'at://did:plc:test/zone.stratos.feed.post/123'

      await db.insert(stratosBacklink).values({
        uri,
        path: 'reply.parent.uri',
        linkTo: 'at://did:plc:other/zone.stratos.feed.post/456',
      })

      await db.insert(stratosBacklink).values({
        uri,
        path: 'reply.root.uri',
        linkTo: 'at://did:plc:other/zone.stratos.feed.post/789',
      })

      const backlinks = await db
        .select()
        .from(stratosBacklink)
        .where(eq(stratosBacklink.uri, uri))

      expect(backlinks).toHaveLength(2)
    })

    it('should find records linking to a target', async () => {
      const targetUri = 'at://did:plc:target/zone.stratos.feed.post/100'

      await db.insert(stratosBacklink).values([
        {
          uri: 'at://did:plc:a/zone.stratos.feed.post/1',
          path: 'reply.parent.uri',
          linkTo: targetUri,
        },
        {
          uri: 'at://did:plc:b/zone.stratos.feed.post/2',
          path: 'reply.parent.uri',
          linkTo: targetUri,
        },
        {
          uri: 'at://did:plc:c/zone.stratos.feed.post/3',
          path: 'reply.parent.uri',
          linkTo: 'at://other',
        },
      ])

      const linking = await db
        .select({ uri: stratosBacklink.uri })
        .from(stratosBacklink)
        .where(eq(stratosBacklink.linkTo, targetUri))

      expect(linking).toHaveLength(2)
      expect(linking.map((r) => r.uri)).toContain(
        'at://did:plc:a/zone.stratos.feed.post/1',
      )
      expect(linking.map((r) => r.uri)).toContain(
        'at://did:plc:b/zone.stratos.feed.post/2',
      )
    })
  })

  describe('stratos_repo_block operations', () => {
    it('should store and retrieve repo blocks', async () => {
      const cid = 'bafyblock123'
      const content = new Uint8Array([1, 2, 3, 4, 5])

      await db.insert(stratosRepoBlock).values({
        cid,
        repoRev: 'rev1',
        size: content.length,
        content: Buffer.from(content),
      })

      const rows = await db
        .select()
        .from(stratosRepoBlock)
        .where(eq(stratosRepoBlock.cid, cid))
      const retrieved = rows[0]

      expect(retrieved).toBeDefined()
      expect(retrieved?.size).toBe(5)
      expect(Buffer.from(retrieved!.content)).toEqual(Buffer.from(content))
    })
  })

  describe('stratos_repo_root operations', () => {
    it('should track root CID and revision', async () => {
      await db.insert(stratosRepoRoot).values({
        did: 'did:plc:test',
        cid: 'bafyroot1',
        rev: 'rev1',
        indexedAt: new Date().toISOString(),
      })

      const rows = await db.select().from(stratosRepoRoot)
      const root = rows[0]

      expect(root?.did).toBe('did:plc:test')
      expect(root?.cid).toBe('bafyroot1')
      expect(root?.rev).toBe('rev1')
    })
  })
})
