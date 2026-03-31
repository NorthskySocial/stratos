import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { CID } from '@atproto/lex-data'
import { type CidLink, decode as cborDecode } from '@atcute/cbor'
import {
  countAll,
  StratosDbOrTx,
  stratosRepoBlock,
  stratosRepoRoot,
} from '../db/index.js'
import { Logger } from '../types.js'

/**
 * Block for CAR streaming
 */
export interface CarBlock {
  cid: CID
  bytes: Uint8Array
}

/**
 * Block map utility
 */
export class BlockMap {
  private map: Map<string, Uint8Array> = new Map()

  set(cid: CID, bytes: Uint8Array): void {
    this.map.set(cid.toString(), bytes)
  }

  get(cid: CID): Uint8Array | undefined {
    return this.map.get(cid.toString())
  }

  has(cid: CID): boolean {
    return this.map.has(cid.toString())
  }

  delete(cid: CID): boolean {
    return this.map.delete(cid.toString())
  }

  getMany(cids: CID[]): { blocks: BlockMap; missing: CID[] } {
    const blocks = new BlockMap()
    const missing: CID[] = []
    for (const cid of cids) {
      const bytes = this.get(cid)
      if (bytes) {
        blocks.set(cid, bytes)
      } else {
        missing.push(cid)
      }
    }
    return { blocks, missing }
  }

  addMap(other: BlockMap): void {
    for (const [key, value] of other.map) {
      this.map.set(key, value)
    }
  }

  entries(): IterableIterator<[string, Uint8Array]> {
    return this.map.entries()
  }

  size(): number {
    return this.map.size
  }
}

/**
 * CID set utility
 */
export class CidSet {
  private set: Set<string> = new Set()

  constructor(cids?: CID[]) {
    if (cids) {
      for (const cid of cids) {
        this.add(cid)
      }
    }
  }

  add(cid: CID): void {
    this.set.add(cid.toString())
  }

  has(cid: CID): boolean {
    return this.set.has(cid.toString())
  }

  delete(cid: CID): boolean {
    return this.set.delete(cid.toString())
  }

  toList(): CID[] {
    return Array.from(this.set).map((s) => CID.parse(s))
  }

  size(): number {
    return this.set.size
  }
}

type RevCursor = {
  rev: string
  cid: string
}

/**
 * Reader for stratos repo blocks
 */
export class StratosSqlRepoReader {
  cache: BlockMap = new BlockMap()

  constructor(
    public readonly db: StratosDbOrTx,
    protected logger?: Logger,
  ) {}

  /**
   * Check if the repository has a root block.
   * @returns True if the root block exists, false otherwise.
   */
  async hasRoot(): Promise<boolean> {
    const res = await this.db
      .select({ cid: stratosRepoRoot.cid })
      .from(stratosRepoRoot)
      .limit(1)
    return res.length > 0
  }

  /**
   * Get the root block CID.
   * @returns The root block CID, or null if not found.
   */
  async getRoot(): Promise<CID | null> {
    const root = await this.getRootDetailed()
    return root?.cid ?? null
  }

  /**
   * Get detailed information about the root block.
   * @returns Root block CID and revision, or null if not found.
   */
  async getRootDetailed(): Promise<{ cid: CID; rev: string } | null> {
    const res = await this.db
      .select({ cid: stratosRepoRoot.cid, rev: stratosRepoRoot.rev })
      .from(stratosRepoRoot)
      .limit(1)
    if (res.length === 0) return null
    return {
      cid: CID.parse(res[0].cid),
      rev: res[0].rev,
    }
  }

  /**
   * Get the content of a block by CID.
   * @param cid - The CID of the block to retrieve.
   * @returns The block content as Uint8Array, or null if not found.
   */
  async getBytes(cid: CID): Promise<Uint8Array | null> {
    const cached = this.cache.get(cid)
    if (cached) return cached
    const found = await this.db
      .select({ content: stratosRepoBlock.content })
      .from(stratosRepoBlock)
      .where(eq(stratosRepoBlock.cid, cid.toString()))
      .limit(1)
    if (found.length === 0) return null
    const content = found[0].content as Uint8Array
    this.cache.set(cid, content)
    return content
  }

  /**
   * Check if a block exists by CID.
   * @param cid - The CID of the block to check.
   * @returns True if the block exists, false otherwise.
   */
  async has(cid: CID): Promise<boolean> {
    const got = await this.getBytes(cid)
    return !!got
  }

  /**
   * Get multiple blocks by their CIDs.
   * @param cids - Array of CIDs to retrieve.
   * @returns Object containing blocks and missing CIDs.
   */
  async getBlocks(cids: CID[]): Promise<{ blocks: BlockMap; missing: CID[] }> {
    const cached = this.cache.getMany(cids)
    if (cached.missing.length < 1) return cached
    const missing = new CidSet(cached.missing)
    const missingStr = cached.missing.map((c) => c.toString())
    const blocks = new BlockMap()

    // Process in batches of 500
    for (let i = 0; i < missingStr.length; i += 500) {
      const batch = missingStr.slice(i, i + 500)
      const res = await this.db
        .select({
          cid: stratosRepoBlock.cid,
          content: stratosRepoBlock.content,
        })
        .from(stratosRepoBlock)
        .where(inArray(stratosRepoBlock.cid, batch))
      for (const row of res) {
        const cid = CID.parse(row.cid)
        blocks.set(cid, row.content as Uint8Array)
        missing.delete(cid)
      }
    }

    this.cache.addMap(blocks)
    blocks.addMap(cached.blocks)
    return { blocks, missing: missing.toList() }
  }

  /**
   * Iterate over CAR blocks in the repository, optionally starting from a specific revision.
   * @param since - Optional revision to start iteration from.
   * @returns Async iterable of CarBlock objects.
   */
  async *iterateCarBlocks(since?: string): AsyncIterable<CarBlock> {
    let cursor: RevCursor | undefined = undefined
    do {
      const res = await this.getBlockRange(since, cursor)
      for (const row of res) {
        yield {
          cid: CID.parse(row.cid),
          bytes: row.content,
        }
      }
      const lastRow = res.at(-1)
      if (lastRow && lastRow.repoRev) {
        cursor = {
          rev: lastRow.repoRev,
          cid: lastRow.cid,
        }
      }
      if (res.length < 500) {
        break
      }
    } while (cursor)
  }

  /**
   * Get a range of blocks from the repository, optionally starting from a specific revision.
   * @param since - Optional revision to start iteration from.
   * @param cursor - Optional cursor to continue iteration from.
   * @returns Array of block details including CID, revision, and content.
   */
  async getBlockRange(
    since?: string,
    cursor?: RevCursor,
  ): Promise<{ cid: string; repoRev: string; content: Uint8Array }[]> {
    const conditions = []

    if (since) {
      conditions.push(gt(stratosRepoBlock.repoRev, since))
    }

    if (cursor) {
      const { rev, cid } = cursor
      conditions.push(
        sql`(${stratosRepoBlock.repoRev}, ${stratosRepoBlock.cid}) < (${rev}, ${cid})`,
      )
    }

    let query = this.db
      .select({
        cid: stratosRepoBlock.cid,
        repoRev: stratosRepoBlock.repoRev,
        content: stratosRepoBlock.content,
      })
      .from(stratosRepoBlock)
      .orderBy(desc(stratosRepoBlock.repoRev), desc(stratosRepoBlock.cid))
      .limit(500)

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query
    }

    const res = await query
    return res.map(
      (row: { cid: string; repoRev: string; content: Buffer }) => ({
        cid: row.cid,
        repoRev: row.repoRev,
        content: new Uint8Array(row.content),
      }),
    )
  }

  /**
   * Get the total number of blocks in the repository.
   * @returns Total number of blocks.
   */
  async countBlocks(): Promise<number> {
    const res = await this.db.select({ count: countAll }).from(stratosRepoBlock)
    return res[0]?.count ?? 0
  }

  /**
   * Preload blocks for a specific revision into the cache.
   * @param rev - Revision to preload blocks for.
   * @returns Promise that resolves when preloading is complete.
   */
  async preloadBlocksForRev(rev: string): Promise<void> {
    const res = await this.db
      .select({
        cid: stratosRepoBlock.cid,
        content: stratosRepoBlock.content,
      })
      .from(stratosRepoBlock)
      .where(eq(stratosRepoBlock.repoRev, rev))
      .limit(15)
    for (const row of res) {
      const cid = CID.parse(row.cid)
      if (!this.cache.has(cid)) {
        this.cache.set(cid, row.content as Uint8Array)
      }
    }
  }

  /**
   * Preload the root spine of a commit into the cache.
   * @param commitCid - CID of the commit to preload the root spine for.
   * @returns Promise that resolves when preloading is complete.
   */
  async preloadRootSpine(commitCid: CID): Promise<void> {
    const commitBytes = await this.getBytes(commitCid)
    if (!commitBytes) return

    const commit = cborDecode(commitBytes) as { data: CidLink }
    const mstRootCid = CID.parse(commit.data.$link)

    const rootBytes = await this.getBytes(mstRootCid)
    if (!rootBytes) return

    const rootNode = cborDecode(rootBytes) as {
      l: CidLink | null
      e: Array<{ t: CidLink | null }>
    }

    const childCids: CID[] = []
    if (rootNode.l) {
      childCids.push(CID.parse(rootNode.l.$link))
    }
    for (const entry of rootNode.e) {
      if (entry.t) {
        childCids.push(CID.parse(entry.t.$link))
      }
    }

    if (childCids.length > 0) {
      await this.getBlocks(childCids)
    }
  }

  /**
   * List all existing blocks in the repository.
   * @returns Set of CIDs representing existing blocks.
   */
  async listExistingBlocks(): Promise<CidSet> {
    const cids = new CidSet()
    let lastCid: string | undefined = ''
    while (lastCid !== undefined) {
      const res = await this.db
        .select({ cid: stratosRepoBlock.cid })
        .from(stratosRepoBlock)
        .where(gt(stratosRepoBlock.cid, lastCid))
        .orderBy(asc(stratosRepoBlock.cid))
        .limit(1000)
      for (const row of res) {
        cids.add(CID.parse(row.cid))
      }
      lastCid = res.at(-1)?.cid
    }
    return cids
  }
}

/**
 * Error thrown when stratos repo root is not found
 */
export class StratosRepoRootNotFoundError extends Error {
  constructor(message?: string) {
    super(message ?? 'Stratos repo root not found')
  }
}
