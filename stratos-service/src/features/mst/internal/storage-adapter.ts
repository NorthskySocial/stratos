import { CID } from '@atproto/lex-data'
import type { ReadonlyBlockStore, BlockMap } from '@atcute/mst'
import { ActorRepoReader } from '../../../actor-store-types.js'

/**
 * A block store adapter for the Stratos actor repository.
 *
 * @param store - The actor repository reader.
 */
export class StratosBlockStoreReader implements ReadonlyBlockStore {
  constructor(private store: ActorRepoReader) {}

  /**
   * Retrieve a block by its CID.
   * @param cid - The CID of the block to retrieve.
   * @returns The block data as Uint8Array<ArrayBuffer> or null if not found.
   */
  async get(cid: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const bytes = await this.store.getBytes(CID.parse(cid))
    if (!bytes) return null
    return bytes as Uint8Array<ArrayBuffer>
  }

  /**
   * Retrieve multiple blocks by their CIDs.
   * @param cids - An array of CIDs to retrieve.
   * @returns An object containing a map of found blocks and an array of missing CIDs.
   */
  async getMany(
    cids: string[],
  ): Promise<{ found: BlockMap; missing: string[] }> {
    const result = await this.store.getBlocks(cids.map((c) => CID.parse(c)))
    const found: BlockMap = new Map()
    for (const [cidStr, bytes] of result.blocks.entries()) {
      found.set(cidStr, bytes as Uint8Array<ArrayBuffer>)
    }
    return { found, missing: result.missing.map((c) => c.toString()) }
  }

  /**
   * Check if a block with the given CID exists in the store.
   * @param cid - The CID to check for existence.
   * @returns A Promise resolving to true if the block exists, false otherwise.
   */
  async has(cid: string): Promise<boolean> {
    return this.store.has(CID.parse(cid))
  }
}
