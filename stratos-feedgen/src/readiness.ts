/**
 * Read-side admission control for projections whose authorization state must
 * be reconciled before they can be safely served.
 */
export interface FeedReadiness {
  isReady: () => boolean
}

export interface ReconciliationOutcome {
  errors: number
  truncated: boolean
}

/**
 * Starts unavailable so callers must explicitly release reads after an
 * authoritative stream session and complete reconciliation. The generation
 * fence prevents an older reconciliation from reopening reads after a newer
 * disconnect or session transition.
 */
export class FeedReadinessGate implements FeedReadiness {
  private ready = false
  private generation = 0
  private hasAuthoritativeSession = false

  isReady(): boolean {
    return this.ready
  }

  markUnavailable(): void {
    this.ready = false
    this.hasAuthoritativeSession = false
    this.generation++
  }

  /**
   * A service stream opened. Its follow-up reconciliation is the first one
   * allowed to release reads, so invalidate any prior result first.
   */
  markSessionEstablished(): void {
    this.markUnavailable()
    this.hasAuthoritativeSession = true
  }

  /** Mark reads unavailable and return the generation this run must satisfy. */
  beginReconciliation(): number {
    this.ready = false
    return this.generation
  }

  /**
   * Release reads only when the run covers every persisted actor, has no
   * authority errors, follows a service session, and is not superseded.
   */
  completeReconciliation(
    generation: number,
    outcome: ReconciliationOutcome,
  ): boolean {
    if (
      !this.hasAuthoritativeSession ||
      generation !== this.generation ||
      outcome.errors > 0 ||
      outcome.truncated
    ) {
      return false
    }
    this.ready = true
    return true
  }
}
