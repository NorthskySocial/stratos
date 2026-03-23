export interface CursorState {
  pdsSeq: number
  stratosCursors: Map<string, number>
}

export class CursorManager {
  private pdsSeq = 0
  private stratosCursors = new Map<string, number>()
  private dirty = false
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private onFlush: (state: CursorState) => Promise<void>

  constructor(
    private flushIntervalMs: number,
    onFlush: (state: CursorState) => Promise<void>,
  ) {
    this.onFlush = onFlush
  }

  start(): void {
    this.flushTimer = setInterval(() => {
      void this.flush()
    }, this.flushIntervalMs)
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }

  updatePdsCursor(seq: number): void {
    this.pdsSeq = seq
    this.dirty = true
  }

  updateStratosCursor(did: string, seq: number): void {
    this.stratosCursors.set(did, seq)
    this.dirty = true
  }

  removeStratosCursor(did: string): void {
    this.stratosCursors.delete(did)
    this.dirty = true
  }

  getPdsCursor(): number {
    return this.pdsSeq
  }

  getStratosCursor(did: string): number | undefined {
    return this.stratosCursors.get(did)
  }

  restore(state: CursorState): void {
    this.pdsSeq = state.pdsSeq
    this.stratosCursors = new Map(state.stratosCursors)
  }

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
