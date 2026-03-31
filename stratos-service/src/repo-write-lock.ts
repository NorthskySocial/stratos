const SWEEP_INTERVAL_MS = 5 * 60_000

/**
 * Application-level per-DID write mutex.
 *
 * Serializes repo writes for the same DID in-process so that only one
 * write at a time enters the database transaction.  Other writers for
 * the same DID await a lightweight promise chain instead of blocking on
 * a PostgreSQL advisory lock (which holds a pool connection while
 * waiting).
 *
 */
export class RepoWriteLocks {
  private locks = new Map<string, Promise<void>>()
  private sweepTimer: ReturnType<typeof setInterval> | undefined

  constructor() {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    // Prevent the timer from keeping the process alive
    this.sweepTimer.unref?.()
  }

  /**
   * Acquire a write lock for the given DID.
   * @param did - The DID to lock.
   * @returns A function that releases the lock.
   */
  async acquire(did: string): Promise<() => void> {
    // Chain behind whatever is currently pending for this DID
    const prev = this.locks.get(did) ?? Promise.resolve()

    let unlock!: () => void
    const gate = new Promise<void>((resolve) => {
      unlock = resolve
    })

    // Register our gate as the new tail of the chain
    this.locks.set(did, gate)

    // Wait for the previous holder to finish
    await prev

    return unlock
  }

  /**
   * Release all locks.
   */
  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
    }
    this.locks.clear()
  }

  /**
   * Remove entries whose promise has already settled (no waiters).
   * @private
   */
  private sweep(): void {
    for (const [did, p] of this.locks) {
      // The settled() helper resolves immediately if p is already done
      const settled = Promise.race([p.then(() => true), Promise.resolve(false)])
      void settled.then((done) => {
        if (done && this.locks.get(did) === p) {
          this.locks.delete(did)
        }
      })
    }
  }
}
