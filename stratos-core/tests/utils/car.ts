import * as AtcuteCid from '@atcute/cid'
import type { CidLink } from '@atcute/cid'
import * as CAR from '@atcute/car'

/**
 * Collects a CAR stream into a single Uint8Array.
 * Useful for testing CAR round-trips.
 */
export async function collectCarStream(
  roots: CidLink[],
  blocks: Array<{ cid: Uint8Array; data: Uint8Array }>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of CAR.writeCarStream(roots, blocks)) {
    chunks.push(chunk)
  }
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

/**
 * Creates a CID string for a string of data.
 * Useful for mocking CID links in tests.
 *
 * @param data - The data to hash.
 * @returns The CID string.
 */
export async function makeCidStr(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data)
  const cid = await AtcuteCid.create(0x71, bytes)
  return AtcuteCid.toString(cid)
}
