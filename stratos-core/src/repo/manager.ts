// WARNING: These imports MUST remain top-level static imports. Switching to
// dynamic `await import()` adds per-call promise/resolution overhead inside the
// transaction, causing ~38% throughput loss and crypto signing stalls under load.
import { encode as cborEncode, toBytes as cborToBytes } from '@atcute/cbor'
import { create as cidCreate, toString as cidToString } from '@atcute/cid'
import type { Cid } from '@atproto/lex-data'
import { parseCid } from '../atproto/index.js'
import { BlockMap } from './reader.js'
import { buildCommit, type UnsignedCommitData } from '../mst/index.js'
import { Logger } from '../types.js'

/** Result of a repository write operation. */
export interface ApplyWritesResult {
  commitCid: Cid
  rev: string
}

/** A write operation for the repository. */
export interface RepoWrite {
  action: 'create' | 'update' | 'delete'
  collection: string
  rkey: string
  record?: unknown
  cid?: Cid
}

/** Service for signing repository commits. */
export interface SigningService {
  signCommit: (did: string, unsignedBytes: Uint8Array) => Promise<Uint8Array>
}

/** Service for sequencing repository changes. */
export interface SequencingService {
  sequenceChange: (
    did: string,
    commitCid: Cid,
    rev: string,
    writes: RepoWrite[],
  ) => Promise<void>
}

/**
 * Minimal interface for repo transactors — satisfied by both
 * StratosSqlRepoTransactor (SQLite) and PgActorRepoTransactor (Postgres).
 */
export interface RepoTransactor {
  lockRoot(): Promise<{ cid: Cid; rev: string } | null>
  updateRoot(cid: Cid, rev: string, did: string): Promise<void>
  getBytes(cid: Cid): Promise<Uint8Array | null>
  has(cid: Cid): Promise<boolean>
  getBlocks(cids: Cid[]): Promise<{ blocks: BlockMap; missing: Cid[] }>
  putBlocks(blocks: BlockMap, rev: string): Promise<void>
  deleteBlocks(cids: Cid[]): Promise<void>
  preloadRootSpine?(commitCid: Cid): Promise<void>
}

// WARNING: This class is performance-critical. Refactoring/restructuring has
// previously caused ~38% throughput regression and ~60% latency increase. Do not:
// - Wrap applyWrites() in a nested transaction (savepoints add journal + lock overhead)
// - Replace the RepoTransactor param with a raw db handle (bypasses the LRU block cache,
//   causing every MST block fetch to hit the database)
// - Convert static imports to dynamic `await import()` (per-call promise overhead)
// - Make persist operations sequential instead of concurrent (connection stalls)
// See PR #83 for the full regression analysis.
export class ActorRepoManager {
  constructor(
    private signingService: SigningService,
    private sequencingService: SequencingService,
    private logger?: Logger,
  ) {}

  /**
   * Apply a batch of writes to an actor's repository.
   *
   * @param did - DID of the actor
   * @param writes - Array of write operations
   * @param transactor - Repo transactor providing block storage and root locking
   * @param extraBlocks - Optional pre-encoded blocks to include in the commit
   */
  async applyWrites(
    did: string,
    writes: RepoWrite[],
    transactor: RepoTransactor,
    extraBlocks?: { cid: Cid; bytes: Uint8Array }[],
  ): Promise<ApplyWritesResult> {
    const currentRootDetailed = await transactor.lockRoot()
    const currentCommitCid = currentRootDetailed?.cid ?? null

    if (currentCommitCid && transactor.preloadRootSpine) {
      await transactor.preloadRootSpine(currentCommitCid)
    }

    const unsigned = await this.buildUnsignedCommit(
      did,
      writes,
      transactor,
      currentCommitCid,
    )

    const { commitCid, commitBytes } = await this.signCommit(did, unsigned)

    const allBlocks = this.collectBlocks(
      commitCid,
      commitBytes,
      unsigned,
      extraBlocks,
    )
    const removedCids = unsigned.removedCids.map((s) => parseCid(s))

    // Concurrent persist — do NOT serialize these. Sequential writes hold the
    // transaction open longer, exhausting the connection pool under load.
    await Promise.all([
      transactor.putBlocks(allBlocks, unsigned.rev),
      removedCids.length > 0 ? transactor.deleteBlocks(removedCids) : undefined,
      transactor.updateRoot(commitCid, unsigned.rev, did),
      this.sequencingService.sequenceChange(
        did,
        commitCid,
        unsigned.rev,
        writes,
      ),
    ])

    return { commitCid, rev: unsigned.rev }
  }

  /**
   * Builds an unsigned commit from a batch of writes.
   *
   * @param did - DID of the actor
   * @param writes - Array of write operations
   * @param transactor - Repo transactor for MST block reads
   * @param currentCommitCid - CID of the current commit, or null for a new repo
   */
  private async buildUnsignedCommit(
    did: string,
    writes: RepoWrite[],
    transactor: RepoTransactor,
    currentCommitCid: Cid | null,
  ): Promise<UnsignedCommitData> {
    const mstWrites = writes.map((w) => ({
      action: w.action,
      collection: w.collection,
      rkey: w.rkey,
      cid: w.cid?.toString() ?? null,
    }))

    const storage = this.createMstStorageAdapter(transactor)

    return await buildCommit(storage, currentCommitCid?.toString() ?? null, {
      did,
      writes: mstWrites,
    })
  }

  /**
   * Creates a storage adapter that bridges the RepoTransactor to the MST builder's
   * expected get/has/getMany interface.
   *
   * @param transactor - Repo transactor for block reads
   */
  private createMstStorageAdapter(transactor: RepoTransactor) {
    return {
      get: async (cidStr: string) => {
        try {
          const bytes = await transactor.getBytes(parseCid(cidStr))
          if (!bytes) return null
          return bytes.slice()
        } catch {
          return null
        }
      },
      has: async (cidStr: string) => {
        try {
          return await transactor.has(parseCid(cidStr))
        } catch {
          return false
        }
      },
      getMany: async (cidStrs: string[]) => {
        const result = await transactor.getBlocks(
          cidStrs.map((c) => parseCid(c)),
        )
        const missing: string[] = []
        const found = new Map<string, Uint8Array<ArrayBuffer>>()
        for (const cidStr of cidStrs) {
          const bytes = result.blocks.get(parseCid(cidStr))
          if (bytes) {
            found.set(cidStr, bytes.slice())
          } else {
            missing.push(cidStr)
          }
        }
        return { found, missing }
      },
    }
  }

  /**
   * Signs an unsigned commit and returns its CID and CBOR-encoded bytes.
   *
   * @param did - DID of the actor
   * @param unsigned - Unsigned commit data from the MST builder
   */
  private async signCommit(
    did: string,
    unsigned: UnsignedCommitData,
  ): Promise<{ commitCid: Cid; commitBytes: Uint8Array }> {
    const unsignedCommit = {
      did: unsigned.did,
      version: unsigned.version,
      data: { $link: unsigned.data },
      rev: unsigned.rev,
      prev: null,
    }

    const unsignedBytes = cborEncode(unsignedCommit)
    const sig = await this.signingService.signCommit(did, unsignedBytes)

    const signedCommit = {
      ...unsignedCommit,
      sig: cborToBytes(sig),
    }

    const commitBytes = cborEncode(signedCommit)
    const atcuteCid = await cidCreate(0x71, commitBytes)
    const commitCid = parseCid(cidToString(atcuteCid))

    return { commitCid, commitBytes }
  }

  /**
   * Collects all blocks (extra, new MST nodes, and the signed commit) into a
   * single BlockMap for persistence.
   *
   * @param commitCid - CID of the signed commit
   * @param commitBytes - CBOR-encoded signed commit
   * @param unsigned - Unsigned commit data containing new MST blocks
   * @param extraBlocks - Optional pre-encoded blocks (e.g., record content)
   */
  private collectBlocks(
    commitCid: Cid,
    commitBytes: Uint8Array,
    unsigned: UnsignedCommitData,
    extraBlocks?: { cid: Cid; bytes: Uint8Array }[],
  ): BlockMap {
    const allBlocks = new BlockMap()
    if (extraBlocks) {
      for (const block of extraBlocks) {
        allBlocks.set(block.cid, block.bytes)
      }
    }
    for (const [cidStr, bytes] of unsigned.newBlocks) {
      allBlocks.set(parseCid(cidStr), bytes)
    }
    allBlocks.set(commitCid, commitBytes)
    return allBlocks
  }
}
