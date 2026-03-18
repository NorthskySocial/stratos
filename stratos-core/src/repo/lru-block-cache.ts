const DEFAULT_MAX_ENTRIES = 5000

export class LruBlockCache {
  private map = new Map<string, Uint8Array>()
  private readonly maxEntries: number

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries
  }

  get(cidStr: string): Uint8Array | undefined {
    const value = this.map.get(cidStr)
    if (value !== undefined) {
      this.map.delete(cidStr)
      this.map.set(cidStr, value)
    }
    return value
  }

  set(cidStr: string, bytes: Uint8Array): void {
    if (this.map.has(cidStr)) {
      this.map.delete(cidStr)
    } else if (this.map.size >= this.maxEntries) {
      const first = this.map.keys().next().value
      if (first !== undefined) this.map.delete(first)
    }
    this.map.set(cidStr, bytes)
  }

  delete(cidStr: string): boolean {
    return this.map.delete(cidStr)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}
