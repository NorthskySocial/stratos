import { describe, expect, it } from 'vitest'
import { CID, type Cid } from '@atproto/lex-data'
import { sha256 } from 'multiformats/hashes/sha2'
import { fromUint8Array } from '@atcute/car'
import { toString as cidToString } from '@atcute/cid'

import {
  type CarBlock,
  exportRepoCarStream,
  type RepoCarSource,
  StratosRepoRootNotFoundError,
} from '../src'

const createCid = async (data: string): Promise<Cid> => {
  const bytes = new TextEncoder().encode(data)
  const hash = await sha256.digest(bytes)
  return CID.createV1(0x71, hash)
}

const collect = async (
  iter: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = []
  for await (const chunk of iter) chunks.push(chunk)
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

describe('exportRepoCarStream', () => {
  it('throws when the repo has no root commit', async () => {
    const source: RepoCarSource = {
      getRootDetailed: async () => null,
      // eslint-disable-next-line require-yield
      iterateCarBlocks: async function* () {
        throw new Error('should not be called')
      },
    }

    await expect(collect(exportRepoCarStream(source))).rejects.toThrow(
      StratosRepoRootNotFoundError,
    )
  })

  it('streams the root commit and every block as a valid CAR', async () => {
    const rootCid = await createCid('motoko')
    const blockA = await createCid('kusanagi')
    const blockB = await createCid('batou')

    const blocks: CarBlock[] = [
      { cid: rootCid, bytes: new TextEncoder().encode('commit') },
      { cid: blockA, bytes: new TextEncoder().encode('node-a') },
      { cid: blockB, bytes: new TextEncoder().encode('node-b') },
    ]

    const source: RepoCarSource = {
      getRootDetailed: async () => ({ cid: rootCid, rev: '3jzfcijpj2z2a' }),
      iterateCarBlocks: async function* () {
        for (const b of blocks) yield b
      },
    }

    const carBytes = await collect(exportRepoCarStream(source))

    const reader = fromUint8Array(carBytes)
    expect(reader.roots.map((r) => r.$link)).toEqual([rootCid.toString()])

    const seen: string[] = []
    for (const entry of reader) {
      seen.push(cidToString(entry.cid))
    }
    expect(seen).toEqual([
      rootCid.toString(),
      blockA.toString(),
      blockB.toString(),
    ])
  })

  it('forwards the since cursor to the block iterator', async () => {
    const rootCid = await createCid('aramaki')
    let receivedSince: string | undefined

    const source: RepoCarSource = {
      getRootDetailed: async () => ({ cid: rootCid, rev: 'rev' }),
      iterateCarBlocks: async function* (since?: string) {
        receivedSince = since
        yield { cid: rootCid, bytes: new TextEncoder().encode('commit') }
      },
    }

    await collect(exportRepoCarStream(source, '3jzfcijpj2z2a'))

    expect(receivedSince).toBe('3jzfcijpj2z2a')
  })
})
