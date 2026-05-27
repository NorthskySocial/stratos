/**
 * Minimal TTL + size-bounded LRU cache.
 *
 * Uses `Map` insertion order to track recency: every read promotes the entry
 * to the most-recent position. Eviction removes the least-recent (first) entry
 * once `max` is exceeded. Entries past their `expiresAt` are treated as misses
 * and removed on access.
 *
 * `now` is injectable so tests can drive expiry deterministically without
 * depending on real timers.
 */
export interface TtlLruOptions {
  ttlMs: number
  max: number
  now?: () => number
}

interface Entry<V> {
  value: V
  expiresAt: number
}

export class TtlLru<K, V> {
  private readonly entries = new Map<K, Entry<V>>()
  private readonly ttlMs: number
  private readonly max: number
  private readonly now: () => number

  constructor(opts: TtlLruOptions) {
    if (opts.ttlMs <= 0) throw new Error('ttlMs must be > 0')
    if (opts.max <= 0) throw new Error('max must be > 0')
    this.ttlMs = opts.ttlMs
    this.max = opts.max
    this.now = opts.now ?? Date.now
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): void {
    if (this.entries.has(key)) {
      this.entries.delete(key)
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs })
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }

  delete(key: K): void {
    this.entries.delete(key)
  }

  get size(): number {
    return this.entries.size
  }
}
