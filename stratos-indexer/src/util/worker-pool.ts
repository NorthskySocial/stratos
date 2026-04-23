export interface WorkerTask<T = unknown> {
  data: T
  resolve: () => void
  reject: (err: Error) => void
}

/**
 * A worker pool that executes tasks asynchronously.
 * @class
 */
export class WorkerPool<T = unknown> {
  private queue: WorkerTask<T>[] = []
  private activeCount = 0
  private running = true
  private handler: (data: T) => Promise<void>
  private onError: (err: Error) => void
  // Backpressure signaling
  private drainWaiters: Array<() => void> = []

  constructor(
    private concurrency: number,
    private maxQueueSize: number,
    handler: (data: T) => Promise<void>,
    onError: (err: Error) => void,
  ) {
    this.handler = handler
    this.onError = onError
  }

  get pendingCount(): number {
    return this.queue.length
  }

  get runningCount(): number {
    return this.activeCount
  }

  /**
   * Submit work to the worker pool.
   * @param data - Data to process.
   * @returns A promise that resolves when the work is completed.
   */
  async submit(data: T): Promise<void> {
    if (!this.running) {
      throw new Error('worker pool is stopped')
    }

    // Backpressure: wait until queue has space
    while (this.queue.length >= this.maxQueueSize) {
      await this.waitForDrain()
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ data, resolve, reject })
      this.drain()
    })
  }

  /**
   * Try to submit work to the worker pool.
   * Returns true if the work was submitted, false otherwise.
   * @param data - Data to process.
   * @returns True if the work was submitted, false otherwise.
   */
  trySubmit(data: T): boolean {
    if (!this.running || this.queue.length >= this.maxQueueSize) {
      return false
    }
    this.queue.push({ data, resolve: () => {}, reject: () => {} })
    this.drain()
    return true
  }

  async stop(): Promise<void> {
    this.running = false
    // Wait for all active work and queued items to finish
    while (this.activeCount > 0 || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  private drain(): void {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()
      if (!task) break
      this.activeCount++
      this.execute(task)
    }
  }

  private execute(task: WorkerTask<T>): void {
    this.handler(task.data)
      .then(() => {
        task.resolve()
      })
      .catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err))
        this.onError(error)
        task.resolve()
      })
      .finally(() => {
        this.activeCount--
        this.drain()
        this.notifyDrain()
      })
  }

  private waitForDrain(): Promise<void> {
    return new Promise((resolve) => {
      this.drainWaiters.push(resolve)
    })
  }

  private notifyDrain(): void {
    while (
      this.queue.length < this.maxQueueSize &&
      this.drainWaiters.length > 0
    ) {
      const waiter = this.drainWaiters.shift()
      if (waiter) waiter()
    }
  }
}
