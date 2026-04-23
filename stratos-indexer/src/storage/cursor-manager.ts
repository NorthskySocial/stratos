export interface CursorState {
  pdsSeq: number
  stratosCursors: Map<string, number>
}

/**
 * Manages cursors for tracking progress in processing data from PDS and Stratos.
 */
export class CursorManager {
  private pdsSeq = 0
  private stratosCursors = new Map<string, number>()
  private dirty = false
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private readonly onFlush: (state: CursorState) => Promise<void>

  constructor(
    private flushIntervalMs: number,
    onFlush: (state: CursorState) => Promise<void>,
  ) {
    this.onFlush = onFlush
  }

  /**
   * Starts the cursor manager.
   */
  start(): void {
    this.flushTimer = setInterval(() => {
      void this.flush()
    }, this.flushIntervalMs)
  }

  /**
   * Stops the cursor manager.
   */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }

  /**
   * Updates the PDS cursor.
   * @param seq The new cursor value.
   */
  updatePdsCursor(seq: number): void {
    this.pdsSeq = seq
    this.dirty = true
  }

  /**
   * Updates the Stratos cursor for a specific DID.
   * @param did The DID for which to update the cursor.
   * @param seq The new cursor value.
   */
  updateStratosCursor(did: string, seq: number): void {
    this.stratosCursors.set(did, seq)
    this.dirty = true
  }

  /**
   * Removes the Stratos cursor for a specific DID.
   * @param did The DID for which to remove the cursor.
   */
  removeStratosCursor(did: string): void {
    this.stratosCursors.delete(did)
    this.dirty = true
  }

  /**
   * Gets the current PDS cursor.
   * @returns The current cursor value.
   */
  getPdsCursor(): number {
    return this.pdsSeq
  }

  /**
   * Gets the current Stratos cursor for a specific DID.
   * @param did The DID for which to get the cursor.
   * @returns The current cursor value, or undefined if not set.
   */
  getStratosCursor(did: string): number | undefined {
    return this.stratosCursors.get(did)
  }

  /**
   * Restores the cursor state from a previous snapshot.
   * @param state The cursor state to restore.
   */
  restore(state: CursorState): void {
    this.pdsSeq = state.pdsSeq
    this.stratosCursors = new Map(state.stratosCursors)
  }

  /**
   * Flushes the current cursor state to the database.
   */
  private async flush(): Promise<void> {
    if (!this.dirty) return

    const state = {
      pdsSeq: this.pdsSeq,
      stratosCursors: new Map(this.stratosCursors),
    }

    await this.onFlush(state)
    this.dirty = false
  }
}
