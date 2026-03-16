const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000

/**
 * Tracks recently-indexed DIDs so we skip redundant indexHandle calls.
 * Each DID is remembered for `ttlMs` before becoming eligible again.
 */
export class HandleDedup {
  private seen = new Map<string, number>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(private ttlMs = DEFAULT_TTL_MS) {
    this.sweepTimer = setInterval(() => this.sweep(), DEFAULT_SWEEP_INTERVAL_MS)
  }

  /** Returns true if this DID should be indexed (not recently seen). */
  shouldIndex(did: string): boolean {
    const now = Date.now()
    const last = this.seen.get(did)
    if (last !== undefined && now - last < this.ttlMs) {
      return false
    }
    this.seen.set(did, now)
    return true
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.seen.clear()
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs
    for (const [did, ts] of this.seen) {
      if (ts < cutoff) {
        this.seen.delete(did)
      }
    }
  }
}
