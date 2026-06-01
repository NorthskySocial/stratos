import { type Cid } from '@northskysocial/stratos-core'

/**
 * A simple Bloom filter for set membership checks with a fixed number of hashes.
 * It provides "fast rejection": if `has` returns false, the item is definitely not in the set.
 * If it returns true, it might be.
 */
class BloomFilter {
  private readonly bits: Uint8Array
  private readonly size: number
  private readonly k: number // number of hash functions

  constructor(sizeInBits: number = 256, k: number = 3) {
    this.size = sizeInBits
    this.bits = new Uint8Array(Math.ceil(sizeInBits / 8))
    this.k = k
  }

  /**
   * Add an item to the set.
   *
   * @param item - The item to add.
   */
  add(item: string): void {
    for (let i = 0; i < this.k; i++) {
      const hash = this.hash(item, i)
      const bitIndex = hash % this.size
      this.bits[Math.floor(bitIndex / 8)] |= 1 << (bitIndex % 8)
    }
  }

  /**
   * Check if an item is in the set.
   *
   * @param item - The item to check.
   * @returns true if the item is in the set, false otherwise.
   */
  has(item: string): boolean {
    for (let i = 0; i < this.k; i++) {
      const hash = this.hash(item, i)
      const bitIndex = hash % this.size
      if (!(this.bits[Math.floor(bitIndex / 8)] & (1 << (bitIndex % 8)))) {
        return false
      }
    }
    return true
  }

  /**
   * Simple hash function using Fowler-Noll-Vo (FNV-1a) logic with an offset seed.
   *
   * @param item - The item to hash.
   * @param seed - The seed for the hash function.
   * @returns The hash value.
   */
  private hash(item: string, seed: number): number {
    let h = 0x811c9dc5 ^ seed
    for (let i = 0; i < item.length; i++) {
      h ^= item.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return h >>> 0
  }
}

/**
 * Manager for Bloom filter rejection logic for blobs and their associated boundaries.
 *
 * This implementation uses a per-blob Bloom filter to maintain memory efficiency
 * while allowing for fast rejection and granular clearing of blob metadata.
 */
export class BloomManager {
  private filters: Map<string, BloomFilter> = new Map()

  /**
   * Updates the Bloom filter with new boundaries for a given blob.
   * @param blobCid - The CID of the blob.
   * @param boundaries - The boundaries associated with the blob.
   */
  async updateBloom(blobCid: Cid, boundaries: string[]): Promise<void> {
    const cidStr = blobCid.toString()
    let filter = this.filters.get(cidStr)
    if (!filter) {
      // 256 bits for boundaries - typically blobs have <10 boundaries,
      // 256 bits provides a very low false positive rate (FPR).
      filter = new BloomFilter(256, 4)
      this.filters.set(cidStr, filter)
    }
    for (const boundary of boundaries) {
      filter.add(boundary)
    }
  }

  /**
   * Checks if any of the provided boundaries might be associated with the blob.
   *
   * This is a "fast rejection" check. If it returns false, the blob definitely
   * DOES NOT have any of the provided boundaries. If it returns true, it MIGHT
   * have one of them (authoritative check required).
   *
   * @param blobCid - The CID of the blob.
   * @param userBoundaries - The boundaries the user has access to.
   * @returns true if there's a possible match, false if definitely no match.
   */
  checkBloom(blobCid: Cid, userBoundaries: string[]): boolean {
    const cidStr = blobCid.toString()
    const filter = this.filters.get(cidStr)

    // If we have no record of this blob in the bloom filter,
    // we should return true to fall back to the authoritative check (DB).
    if (!filter) {
      return true
    }

    // Check if there's any intersection between user boundaries and blob boundaries
    for (const boundary of userBoundaries) {
      if (filter.has(boundary)) {
        return true
      }
    }

    return false
  }

  /**
   * Clears the filter for a specific blob.
   *
   * @param blobCid - The CID of the blob to clear.
   */
  async clearBloom(blobCid: Cid): Promise<void> {
    this.filters.delete(blobCid.toString())
  }
}
