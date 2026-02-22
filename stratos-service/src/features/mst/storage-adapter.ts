import { CID } from 'multiformats/cid'
import type { ReadonlyBlockStore, BlockMap } from '@atcute/mst'
import type {
  StratosSqlRepoReader,
  StratosSqlRepoTransactor,
} from '@northskysocial/stratos-core'

export class StratosBlockStoreReader implements ReadonlyBlockStore {
  constructor(private store: StratosSqlRepoReader | StratosSqlRepoTransactor) {}

  async get(cid: string): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.store.getBytes(CID.parse(cid)) as Promise<Uint8Array<ArrayBuffer> | null>
  }

  async getMany(cids: string[]): Promise<{ found: BlockMap; missing: string[] }> {
    const result = await this.store.getBlocks(cids.map(c => CID.parse(c)))
    const found: BlockMap = new Map()
    for (const [cidStr, bytes] of result.blocks.entries()) {
      found.set(cidStr, bytes as Uint8Array<ArrayBuffer>)
    }
    return { found, missing: result.missing.map(c => c.toString()) }
  }

  async has(cid: string): Promise<boolean> {
    return this.store.has(CID.parse(cid))
  }
}
