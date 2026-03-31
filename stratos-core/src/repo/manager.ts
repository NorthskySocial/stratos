import { CID } from '@atproto/lex-data'
import { BlockMap, StratosSqlRepoTransactor } from './index.js'
import { buildCommit, type UnsignedCommitData } from '../mst/index.js'
import { Logger } from '../types.js'
import { StratosDbOrTx } from '../db/index.js'

/**
 * Result of a repository write operation
 */
export interface ApplyWritesResult {
  commitCid: CID
  rev: string
}

/**
 * A write operation for the repository
 */
export interface RepoWrite {
  action: 'create' | 'update' | 'delete'
  collection: string
  rkey: string
  record?: unknown
  cid?: CID
}

/**
 * Service for signing repository commits
 */
export interface SigningService {
  signCommit(did: string, unsignedBytes: Uint8Array): Promise<Uint8Array>
}

/**
 * Service for sequencing repository changes
 */
export interface SequencingService {
  sequenceChange(
    did: string,
    commitCid: CID,
    rev: string,
    writes: RepoWrite[],
  ): Promise<void>
}

/**
 * Manager for actor repository operations
 */
export class ActorRepoManager {
  constructor(
    private db: StratosDbOrTx,
    private signingService: SigningService,
    private sequencingService: SequencingService,
    private logger?: Logger,
  ) {}

  /**
   * Apply a batch of writes to an actor's repository
   *
   * @param did - DID of the actor
   * @param writes - Array of write operations
   * @param extraBlocks - Optional array of extra blocks to include in the commit
   * @returns CID of the committed changes
   */
  async applyWrites(
    did: string,
    writes: RepoWrite[],
    extraBlocks?: { cid: CID; bytes: Uint8Array }[],
  ): Promise<ApplyWritesResult> {
    return await (
      this.db as {
        transaction: (
          fn: (tx: StratosDbOrTx) => Promise<ApplyWritesResult>,
        ) => Promise<ApplyWritesResult>
      }
    ).transaction(async (tx: StratosDbOrTx) => {
      const transactor = new StratosSqlRepoTransactor(tx, this.logger)

      // 1. Get the current root (and lock it if the DB supports it)
      const currentRootDetailed = await transactor.lockRoot()
      const currentCommitCid = currentRootDetailed?.cid ?? null

      // 2. Build the new MST and unsigned commit
      const unsigned = await this.buildUnsignedCommit(
        did,
        writes,
        transactor,
        currentCommitCid,
      )

      // 3. Sign the commit and generate its CID
      const { commitCid, commitBytes } = await this.signCommit(did, unsigned)

      // 4. Persist blocks and update root
      await this.persistCommit(
        transactor,
        commitCid,
        commitBytes,
        unsigned,
        extraBlocks,
      )

      // 5. Update root and sequence the change
      await transactor.updateRoot(commitCid, unsigned.rev, did)
      await this.sequencingService.sequenceChange(
        did,
        commitCid,
        unsigned.rev,
        writes,
      )

      return {
        commitCid,
        rev: unsigned.rev,
      }
    })
  }

  /**
   * Builds an unsigned commit from a batch of writes
   *
   * @param did - DID of the actor
   * @param writes - Array of write operations
   * @param transactor - Transaction object
   * @param currentCommitCid - CID of the current commit, or null if starting a new repo
   * @returns Unsigned commit data
   */
  private async buildUnsignedCommit(
    did: string,
    writes: RepoWrite[],
    transactor: StratosSqlRepoTransactor,
    currentCommitCid: CID | null,
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
   * Creates a storage adapter for the MST builder
   *
   * @param transactor - Transaction object
   * @returns Storage adapter object
   */
  private createMstStorageAdapter(transactor: StratosSqlRepoTransactor) {
    return {
      get: async (cidStr: string) => {
        try {
          const bytes = await transactor.getBytes(CID.parse(cidStr))
          if (!bytes) return null
          return new Uint8Array(bytes)
        } catch {
          return null
        }
      },
      has: async (cidStr: string) => {
        try {
          return await transactor.has(CID.parse(cidStr))
        } catch {
          return false
        }
      },
      getMany: async (cidStrs: string[]) => {
        const result = await transactor.getBlocks(
          cidStrs.map((c) => CID.parse(c)),
        )
        const missing: string[] = []
        const found = new Map<string, Uint8Array>()
        for (const cidStr of cidStrs) {
          const bytes = result.blocks.get(CID.parse(cidStr))
          if (bytes) {
            found.set(cidStr, bytes)
          } else {
            missing.push(cidStr)
          }
        }
        return { found, missing }
      },
    }
  }

  /**
   * Signs a commit and returns its CID and encoded bytes
   *
   * @param did - DID of the actor
   * @param unsigned - Unsigned commit data
   * @returns CID and encoded bytes of the signed commit
   */
  private async signCommit(
    did: string,
    unsigned: UnsignedCommitData,
  ): Promise<{ commitCid: CID; commitBytes: Uint8Array }> {
    const unsignedCommit = {
      did: unsigned.did,
      version: unsigned.version,
      data: { $link: unsigned.data },
      rev: unsigned.rev,
      prev: null,
    }

    const { encode: cborEncode, toBytes: cborToBytes } =
      await import('@atcute/cbor')
    const unsignedBytes = cborEncode(unsignedCommit)
    const sig = await this.signingService.signCommit(did, unsignedBytes)

    const signedCommit = {
      ...unsignedCommit,
      sig: cborToBytes(sig),
    }

    const commitBytes = cborEncode(signedCommit)
    const { create: cidCreate, toString: cidToString } =
      await import('@atcute/cid')
    const atcuteCid = await cidCreate(0x71, commitBytes)
    const commitCid = CID.parse(cidToString(atcuteCid))

    return { commitCid, commitBytes }
  }

  /**
   * Persists all blocks related to a commit
   *
   * @param transactor - Transaction object
   * @param commitCid - CID of the commit
   * @param commitBytes - Encoded bytes of the commit
   * @param unsigned - Unsigned commit data
   * @param extraBlocks - Optional array of extra blocks to include in the commit
   */
  private async persistCommit(
    transactor: StratosSqlRepoTransactor,
    commitCid: CID,
    commitBytes: Uint8Array,
    unsigned: UnsignedCommitData,
    extraBlocks?: { cid: CID; bytes: Uint8Array }[],
  ): Promise<void> {
    const allBlocks = new BlockMap()
    if (extraBlocks) {
      for (const block of extraBlocks) {
        allBlocks.set(block.cid, block.bytes)
      }
    }
    for (const [cidStr, bytes] of unsigned.newBlocks) {
      allBlocks.set(CID.parse(cidStr), bytes)
    }
    allBlocks.set(commitCid, commitBytes)

    await transactor.putBlocks(allBlocks, unsigned.rev)

    if (unsigned.removedCids.length > 0) {
      await transactor.deleteBlocks(
        unsigned.removedCids.map((s) => CID.parse(s)),
      )
    }
  }
}
