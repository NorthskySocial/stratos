import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { CID, Cid } from '@atproto/lex-data'
import { sha256 } from 'multiformats/hashes/sha2'

import {
  ActorRepoManager,
  closeStratosDb,
  createStratosDb,
  migrateStratosDb,
  RepoWrite,
  SequencingService,
  SigningService,
  StratosDb,
  stratosRepoBlock,
  stratosRepoRoot,
} from '../src/index.js'

// Simple encoding for tests
const encodeRecord = (data: unknown): Uint8Array => {
  return new TextEncoder().encode(JSON.stringify(data))
}

// Create a deterministic CID from data
const createCid = async (data: unknown): Promise<Cid> => {
  const bytes = encodeRecord(data)
  const hash = await sha256.digest(bytes)
  return CID.createV1(0x55, hash)
}

describe('ActorRepoManager', () => {
  let db: StratosDb
  let manager: ActorRepoManager
  let testDir: string
  let dbPath: string
  let mockSigningService: SigningService
  let mockSequencingService: SequencingService

  const did = 'did:plc:test'

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-repo-manager-test-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })
    dbPath = join(testDir, 'test.db')

    db = createStratosDb(dbPath)
    await migrateStratosDb(db)

    mockSigningService = {
      signCommit: vi.fn().mockResolvedValue(new Uint8Array(64).fill(1)),
    }
    mockSequencingService = {
      sequenceChange: vi.fn().mockResolvedValue(undefined),
    }

    manager = new ActorRepoManager(
      db,
      mockSigningService,
      mockSequencingService,
    )
  })

  afterEach(async () => {
    await closeStratosDb(db)
    await rm(testDir, { recursive: true, force: true })
  })

  it('should apply initial writes to an empty repo', async () => {
    const record = { text: 'Hello, Stratos!' }
    const cid = await createCid(record)
    const writes: RepoWrite[] = [
      {
        action: 'create',
        collection: 'zone.stratos.feed.post',
        rkey: '1',
        record,
        cid,
      },
    ]

    const result = await manager.applyWrites(did, writes, [
      { cid, bytes: encodeRecord(record) },
    ])

    expect(result.commitCid).toBeDefined()
    expect(result.rev).toBeDefined()

    // Verify root update
    const root = await db.select().from(stratosRepoRoot).execute()
    expect(root[0].did).toBe(did)
    expect(root[0].cid).toBe(result.commitCid.toString())
    expect(root[0].rev).toBe(result.rev)

    // Verify blocks persisted
    const commitBlock = await db.select().from(stratosRepoBlock).execute()
    const cidStrs = commitBlock.map((b) => b.cid)
    expect(cidStrs).toContain(result.commitCid.toString())
    expect(cidStrs).toContain(cid.toString())

    // Verify services called
    expect(mockSigningService.signCommit).toHaveBeenCalledWith(
      did,
      expect.any(Uint8Array),
    )
    expect(mockSequencingService.sequenceChange).toHaveBeenCalledWith(
      did,
      result.commitCid,
      result.rev,
      writes,
    )
  })

  it('should update an existing repository', async () => {
    // 1. Initial write
    const record1 = { text: 'First post' }
    const cid1 = await createCid(record1)
    await manager.applyWrites(
      did,
      [
        {
          action: 'create',
          collection: 'zone.stratos.feed.post',
          rkey: '1',
          record: record1,
          cid: cid1,
        },
      ],
      [{ cid: cid1, bytes: encodeRecord(record1) }],
    )

    // 2. Update write
    const record2 = { text: 'Updated post' }
    const cid2 = await createCid(record2)
    const writes: RepoWrite[] = [
      {
        action: 'update',
        collection: 'zone.stratos.feed.post',
        rkey: '1',
        record: record2,
        cid: cid2,
      },
    ]

    const result = await manager.applyWrites(did, writes, [
      { cid: cid2, bytes: encodeRecord(record2) },
    ])

    expect(result.commitCid).toBeDefined()
    expect(result.rev).toBeDefined()

    // Verify root updated to new commit
    const root = await db.select().from(stratosRepoRoot).execute()
    expect(root[0].cid).toBe(result.commitCid.toString())

    // Verify new block persisted
    const block = await db.select().from(stratosRepoBlock).execute()
    const cidStrs = block.map((b) => b.cid)
    expect(cidStrs).toContain(cid2.toString())
  })
})
