import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { CID, Cid } from '@atproto/lex-data'
import { sha256 } from 'multiformats/hashes/sha2'
import { eq } from 'drizzle-orm'

import {
  BlockMap,
  closeStratosDb,
  createStratosDb,
  migrateStratosDb,
  type StratosDb,
  stratosRepoBlock,
  stratosRepoRoot,
  StratosSqlRepoReader,
  StratosSqlRepoTransactor,
} from '../src'

// Create a deterministic CID from data
const createCid = async (data: string | Uint8Array): Promise<Cid> => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const hash = await sha256.digest(bytes)
  return CID.createV1(0x55, hash)
}

describe('Repo Reader', () => {
  let db: StratosDb
  let reader: StratosSqlRepoReader
  let testDir: string

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-repo-test-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })
    const dbPath = join(testDir, 'test.db')

    db = createStratosDb(dbPath)
    await migrateStratosDb(db)
    reader = new StratosSqlRepoReader(db)
  })

  afterEach(async () => {
    await closeStratosDb(db)
    await rm(testDir, { recursive: true, force: true })
  })

  describe('hasRoot', () => {
    it('should return false for empty repo', async () => {
      const result = await reader.hasRoot()
      expect(result).toBe(false)
    })

    it('should return true after root is set', async () => {
      const cid = await createCid('root')
      await db.insert(stratosRepoRoot).values({
        did: 'did:plc:test',
        cid: cid.toString(),
        rev: 'rev1',
        indexedAt: new Date().toISOString(),
      })

      const result = await reader.hasRoot()
      expect(result).toBe(true)
    })
  })

  describe('getRoot', () => {
    it('should return null for empty repo', async () => {
      const result = await reader.getRoot()
      expect(result).toBeNull()
    })

    it('should return root CID', async () => {
      const cid = await createCid('root cid')
      await db.insert(stratosRepoRoot).values({
        did: 'did:plc:test',
        cid: cid.toString(),
        rev: 'rev1',
        indexedAt: new Date().toISOString(),
      })

      const result = await reader.getRoot()
      expect(result).not.toBeNull()
      expect(result?.toString()).toBe(cid.toString())
    })
  })

  describe('getRootDetailed', () => {
    it('should return null for empty repo', async () => {
      const result = await reader.getRootDetailed()
      expect(result).toBeNull()
    })

    it('should return CID and rev', async () => {
      const cid = await createCid('detailed root')
      await db.insert(stratosRepoRoot).values({
        did: 'did:plc:test',
        cid: cid.toString(),
        rev: 'myrev123',
        indexedAt: new Date().toISOString(),
      })

      const result = await reader.getRootDetailed()
      expect(result).not.toBeNull()
      expect(result?.cid.toString()).toBe(cid.toString())
      expect(result?.rev).toBe('myrev123')
    })
  })

  describe('getBytes', () => {
    it('should return null for non-existent block', async () => {
      const cid = await createCid('nonexistent')
      const result = await reader.getBytes(cid)
      expect(result).toBeNull()
    })

    it('should return block content', async () => {
      const cid = await createCid('block content')
      const content = new Uint8Array([10, 20, 30])

      await db.insert(stratosRepoBlock).values({
        cid: cid.toString(),
        repoRev: 'rev1',
        size: content.length,
        content: Buffer.from(content),
      })

      const result = await reader.getBytes(cid)
      expect(result).not.toBeNull()
      expect(Buffer.from(result!)).toEqual(Buffer.from(content))
    })

    it('should cache retrieved blocks', async () => {
      const cid = await createCid('cached block')
      const content = new Uint8Array([40, 50, 60])

      await db.insert(stratosRepoBlock).values({
        cid: cid.toString(),
        repoRev: 'rev1',
        size: content.length,
        content: Buffer.from(content),
      })

      // First retrieval
      const result1 = await reader.getBytes(cid)
      expect(result1).not.toBeNull()

      // Delete from DB
      await db
        .delete(stratosRepoBlock)
        .where(eq(stratosRepoBlock.cid, cid.toString()))

      // Should still return from cache
      const result2 = await reader.getBytes(cid)
      expect(result2).not.toBeNull()
      expect(Buffer.from(result2!)).toEqual(Buffer.from(content))
    })
  })

  describe('has', () => {
    it('should return false for non-existent block', async () => {
      const cid = await createCid('nope')
      const result = await reader.has(cid)
      expect(result).toBe(false)
    })

    it('should return true for existing block', async () => {
      const cid = await createCid('exists')
      await db.insert(stratosRepoBlock).values({
        cid: cid.toString(),
        repoRev: 'rev1',
        size: 3,
        content: Buffer.from([1, 2, 3]),
      })

      const result = await reader.has(cid)
      expect(result).toBe(true)
    })
  })

  describe('getBlocks', () => {
    it('should return blocks and report missing', async () => {
      const cid1 = await createCid('block1')
      const cid2 = await createCid('block2')
      const cid3 = await createCid('missing')

      await db.insert(stratosRepoBlock).values([
        {
          cid: cid1.toString(),
          repoRev: 'rev1',
          size: 1,
          content: Buffer.from([1]),
        },
        {
          cid: cid2.toString(),
          repoRev: 'rev1',
          size: 1,
          content: Buffer.from([2]),
        },
      ])

      const { blocks, missing } = await reader.getBlocks([cid1, cid2, cid3])

      expect(blocks.has(cid1)).toBe(true)
      expect(blocks.has(cid2)).toBe(true)
      expect(blocks.has(cid3)).toBe(false)
      expect(missing).toHaveLength(1)
      expect(missing[0].toString()).toBe(cid3.toString())
    })
  })
})

describe('Repo Transactor', () => {
  let db: StratosDb
  let transactor: StratosSqlRepoTransactor
  let testDir: string
  const testDid = 'did:plc:test'

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-repo-tx-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })
    const dbPath = join(testDir, 'test.db')

    db = createStratosDb(dbPath)
    await migrateStratosDb(db)
    transactor = new StratosSqlRepoTransactor(db)
  })

  afterEach(async () => {
    await closeStratosDb(db)
    await rm(testDir, { recursive: true, force: true })
  })

  describe('updateRoot', () => {
    it('should set initial root', async () => {
      const cid = await createCid('initial root')

      await transactor.updateRoot(cid, 'rev1', testDid)

      const root = await transactor.getRootDetailed()
      expect(root?.cid.toString()).toBe(cid.toString())
      expect(root?.rev).toBe('rev1')
    })

    it('should update existing root', async () => {
      const cid1 = await createCid('root1')
      const cid2 = await createCid('root2')

      await transactor.updateRoot(cid1, 'rev1', testDid)
      await transactor.updateRoot(cid2, 'rev2', testDid)

      const root = await transactor.getRootDetailed()
      expect(root?.cid.toString()).toBe(cid2.toString())
      expect(root?.rev).toBe('rev2')
    })
  })

  describe('putBlock', () => {
    it('should store a block', async () => {
      const cid = await createCid('stored block')
      const bytes = new Uint8Array([1, 2, 3, 4, 5])

      await transactor.putBlock(cid, bytes, 'rev1')

      const retrieved = await transactor.getBytes(cid)
      expect(retrieved).not.toBeNull()
      expect(Buffer.from(retrieved!)).toEqual(Buffer.from(bytes))
    })

    it('should cache stored blocks', async () => {
      const cid = await createCid('cached stored')
      const bytes = new Uint8Array([6, 7, 8])

      await transactor.putBlock(cid, bytes, 'rev1')

      // Should be in cache immediately
      const cached = transactor.cache.get(cid)
      expect(cached).not.toBeUndefined()
      expect(Buffer.from(cached!)).toEqual(Buffer.from(bytes))
    })

    it('should not fail on duplicate insert', async () => {
      const cid = await createCid('duplicate block')
      const bytes = new Uint8Array([9, 10, 11])

      await transactor.putBlock(cid, bytes, 'rev1')
      await expect(
        transactor.putBlock(cid, bytes, 'rev1'),
      ).resolves.not.toThrow()
    })
  })

  describe('putBlocks', () => {
    it('should store multiple blocks', async () => {
      const cid1 = await createCid('multi1')
      const cid2 = await createCid('multi2')
      const blocks = new BlockMap()
      blocks.set(cid1, new Uint8Array([1]))
      blocks.set(cid2, new Uint8Array([2]))

      await transactor.putBlocks(blocks, 'rev1')

      expect(await transactor.has(cid1)).toBe(true)
      expect(await transactor.has(cid2)).toBe(true)
    })
  })

  describe('deleteBlock', () => {
    it('should delete a block', async () => {
      const cid = await createCid('deleteme')
      await transactor.putBlock(cid, new Uint8Array([1, 2, 3]), 'rev1')

      expect(await transactor.has(cid)).toBe(true)

      await transactor.deleteBlock(cid)

      // Check DB (not cache)
      const dbResult = await db
        .select()
        .from(stratosRepoBlock)
        .where(eq(stratosRepoBlock.cid, cid.toString()))
        .limit(1)
      expect(dbResult[0]).toBeUndefined()
    })

    it('should remove from cache', async () => {
      const cid = await createCid('cache delete')
      await transactor.putBlock(cid, new Uint8Array([1]), 'rev1')

      expect(transactor.cache.has(cid)).toBe(true)

      await transactor.deleteBlock(cid)

      expect(transactor.cache.has(cid)).toBe(false)
    })
  })

  describe('deleteBlocks', () => {
    it('should delete multiple blocks', async () => {
      const cid1 = await createCid('del1')
      const cid2 = await createCid('del2')
      const cid3 = await createCid('keep1')

      await transactor.putBlock(cid1, new Uint8Array([1]), 'rev1')
      await transactor.putBlock(cid2, new Uint8Array([2]), 'rev1')
      await transactor.putBlock(cid3, new Uint8Array([3]), 'rev1')

      await transactor.deleteBlocks([cid1, cid2])

      const count = await db
        .select({ cid: stratosRepoBlock.cid })
        .from(stratosRepoBlock)
      expect(count).toHaveLength(1)
      expect(count[0].cid).toBe(cid3.toString())
    })
  })

  describe('deleteBlocksForRev', () => {
    it('should delete all blocks for a revision', async () => {
      const cid1 = await createCid('rev1-block1')
      const cid2 = await createCid('rev1-block2')
      const cid3 = await createCid('rev2-block1')

      await transactor.putBlock(cid1, new Uint8Array([1]), 'rev1')
      await transactor.putBlock(cid2, new Uint8Array([2]), 'rev1')
      await transactor.putBlock(cid3, new Uint8Array([3]), 'rev2')

      await transactor.deleteBlocksForRev('rev1')

      const remaining = await db
        .select({ cid: stratosRepoBlock.cid })
        .from(stratosRepoBlock)
      expect(remaining).toHaveLength(1)
      expect(remaining[0].cid).toBe(cid3.toString())
    })
  })

  describe('clearCache', () => {
    it('should clear the cache', async () => {
      const cid = await createCid('cached')
      await transactor.putBlock(cid, new Uint8Array([1]), 'rev1')

      expect(transactor.cache.size()).toBe(1)

      await transactor.clearCache()

      expect(transactor.cache.size()).toBe(0)
    })
  })
})
