const DEFAULT_MAX_ENTRIES = 5000

/**
 * LRU block cache for storing recently accessed blocks.
 * Provides a cache with a maximum number of entries, evicting the least recently used items when full.
 */
export class LruBlockCache {
  private map = new Map<string, Uint8Array>()
  private readonly maxEntries: number

  /**
   * Create a new LRU block cache.
   * @param maxEntries - Maximum number of entries to store. Defaults to 5000.
   * @returns A new LRU block cache instance.
   */
  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries
  }

  /**
   * Get the number of entries in the cache.
   * @returns The number of entries.
   */
  get size(): number {
    return this.map.size
  }

  /**
   * Get a value from the cache, moving it to the end of the LRU list.
   * @param cidStr - CID string to look up.
   * @returns The value if found, undefined otherwise.
   */
  get(cidStr: string): Uint8Array | undefined {
    const value = this.map.get(cidStr)
    if (value !== undefined) {
      this.map.delete(cidStr)
      this.map.set(cidStr, value)
    }
    return value
  }

  /**
   * Set a value in the cache, potentially evicting the least recently used item if the cache is full.
   * @param cidStr - CID string to set.
   * @param bytes - Value to set.
   */
  set(cidStr: string, bytes: Uint8Array): void {
    if (this.map.has(cidStr)) {
      this.map.delete(cidStr)
    } else if (this.map.size >= this.maxEntries) {
      const first = this.map.keys().next().value
      if (first !== undefined) this.map.delete(first)
    }
    this.map.set(cidStr, bytes)
  }

  /**
   * Delete a value from the cache.
   * @param cidStr - CID string to delete.
   * @returns True if the value was found and deleted, false otherwise.
   */
  delete(cidStr: string): boolean {
    return this.map.delete(cidStr)
  }

  /**
   * Clear the cache.
   */
  clear(): void {
    this.map.clear()
  }
}
