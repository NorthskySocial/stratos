import type {
  EnrollmentStoreWriter,
  StoredEnrollment,
  ListEnrollmentsOptions,
} from '@northskysocial/stratos-core'

/**
 * Simple bloom filter for fast negative lookups on enrollment status.
 * False positives are OK (we fall through to cache/DB), false negatives are not.
 */
class BloomFilter {
  private bits: Uint32Array
  private readonly numBits: number
  private readonly numHashes: number

  constructor(expectedItems: number, falsePositiveRate = 0.01) {
    this.numBits = Math.max(
      64,
      Math.ceil(
        (-expectedItems * Math.log(falsePositiveRate)) / (Math.LN2 * Math.LN2),
      ),
    )
    this.numHashes = Math.max(
      1,
      Math.round((this.numBits / expectedItems) * Math.LN2),
    )
    this.bits = new Uint32Array(Math.ceil(this.numBits / 32))
  }

  private hash(str: string, seed: number): number {
    let h = seed ^ str.length
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 0x5bd1e995)
      h ^= h >>> 15
    }
    return (h >>> 0) % this.numBits
  }

  add(item: string): void {
    for (let i = 0; i < this.numHashes; i++) {
      const bit = this.hash(item, i)
      this.bits[bit >>> 5] |= 1 << (bit & 31)
    }
  }

  mightContain(item: string): boolean {
    for (let i = 0; i < this.numHashes; i++) {
      const bit = this.hash(item, i)
      if ((this.bits[bit >>> 5] & (1 << (bit & 31))) === 0) {
        return false
      }
    }
    return true
  }

  clear(): void {
    this.bits.fill(0)
  }
}

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

/**
 * LRU cache with TTL expiry. Evicts least-recently-used entries when capacity is reached.
 */
class LruCache<T> {
  private cache = new Map<string, CacheEntry<T>>()
  private readonly maxSize: number
  private readonly ttlMs: number

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize
    this.ttlMs = ttlMs
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return undefined
    }
    // Move to end (most recently used)
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.value
  }

  set(key: string, value: T): void {
    this.cache.delete(key)
    if (this.cache.size >= this.maxSize) {
      // Evict oldest (first) entry
      const first = this.cache.keys().next().value
      if (first !== undefined) this.cache.delete(first)
    }
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs })
  }

  delete(key: string): void {
    this.cache.delete(key)
  }
}

export interface CachedEnrollmentStoreOptions {
  /** Max entries in the LRU cache (default: 10000) */
  maxCacheSize?: number
  /** Cache TTL in milliseconds (default: 60000 = 1 minute) */
  cacheTtlMs?: number
  /** Expected number of enrollments for bloom filter sizing (default: 10000) */
  expectedEnrollments?: number
}

/**
 * Wraps an EnrollmentStoreWriter with a bloom filter for fast isEnrolled() rejection
 * and an LRU cache for isEnrolled() and getBoundaries() results.
 *
 * On startup, call `warm()` to populate the bloom filter from existing enrollments.
 * Write operations (enroll, unenroll, setBoundaries, etc.) invalidate cache entries
 * and update the bloom filter.
 */
export class CachedEnrollmentStore implements EnrollmentStoreWriter {
  private readonly inner: EnrollmentStoreWriter
  private readonly bloom: BloomFilter
  private readonly enrolledCache: LruCache<boolean>
  private readonly boundariesCache: LruCache<string[]>

  constructor(
    inner: EnrollmentStoreWriter,
    options?: CachedEnrollmentStoreOptions,
  ) {
    const maxCacheSize = options?.maxCacheSize ?? 10_000
    const cacheTtlMs = options?.cacheTtlMs ?? 60_000
    const expectedEnrollments = options?.expectedEnrollments ?? 10_000

    this.inner = inner
    this.bloom = new BloomFilter(expectedEnrollments)
    this.enrolledCache = new LruCache<boolean>(maxCacheSize, cacheTtlMs)
    this.boundariesCache = new LruCache<string[]>(maxCacheSize, cacheTtlMs)
  }

  /**
   * Populate bloom filter from existing enrollments. Call once at startup.
   */
  async warm(): Promise<void> {
    let cursor: string | undefined
    for (;;) {
      const batch = await this.inner.listEnrollments({
        limit: 500,
        cursor,
      })
      if (batch.length === 0) break
      for (const enrollment of batch) {
        if (enrollment.active) {
          this.bloom.add(enrollment.did)
        }
      }
      cursor = batch[batch.length - 1].did
    }
  }

  // ─── Read Operations (cached) ──────────────────────────────────────────

  async isEnrolled(did: string): Promise<boolean> {
    // Bloom filter: fast negative path
    if (!this.bloom.mightContain(did)) {
      return false
    }

    // LRU cache check
    const cached = this.enrolledCache.get(did)
    if (cached !== undefined) return cached

    // Fall through to DB
    const result = await this.inner.isEnrolled(did)
    this.enrolledCache.set(did, result)
    return result
  }

  async getBoundaries(did: string): Promise<string[]> {
    const cached = this.boundariesCache.get(did)
    if (cached !== undefined) return cached

    const result = await this.inner.getBoundaries(did)
    this.boundariesCache.set(did, result)
    return result
  }

  async getEnrollment(did: string): Promise<StoredEnrollment | null> {
    return this.inner.getEnrollment(did)
  }

  async listEnrollments(
    options?: ListEnrollmentsOptions,
  ): Promise<StoredEnrollment[]> {
    return this.inner.listEnrollments(options)
  }

  async enrollmentCount(): Promise<number> {
    return this.inner.enrollmentCount()
  }

  // ─── Write Operations (invalidate cache) ───────────────────────────────

  async enroll(enrollment: StoredEnrollment): Promise<void> {
    await this.inner.enroll(enrollment)
    if (enrollment.active) {
      this.bloom.add(enrollment.did)
    }
    this.enrolledCache.delete(enrollment.did)
    this.boundariesCache.delete(enrollment.did)
  }

  async unenroll(did: string): Promise<void> {
    await this.inner.unenroll(did)
    // Can't remove from bloom filter, but cache invalidation handles correctness
    this.enrolledCache.delete(did)
    this.boundariesCache.delete(did)
  }

  async updateEnrollment(
    did: string,
    updates: Partial<Omit<StoredEnrollment, 'did'>>,
  ): Promise<void> {
    await this.inner.updateEnrollment(did, updates)
    this.enrolledCache.delete(did)
  }

  async setBoundaries(did: string, boundaries: string[]): Promise<void> {
    await this.inner.setBoundaries(did, boundaries)
    this.boundariesCache.delete(did)
  }

  async addBoundary(did: string, boundary: string): Promise<void> {
    await this.inner.addBoundary(did, boundary)
    this.boundariesCache.delete(did)
  }

  async removeBoundary(did: string, boundary: string): Promise<void> {
    await this.inner.removeBoundary(did, boundary)
    this.boundariesCache.delete(did)
  }
}
