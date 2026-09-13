export interface ReconcileTrigger {
  (): void
  /** Await the initial pass; false means shutdown interrupted startup. */
  initialize: () => Promise<boolean>
  stop: () => Promise<void>
  abortActivePass: () => void
}

const INITIAL_RETRY_DELAY_MS = 5_000
const MAX_RETRY_DELAY_MS = 60_000

/** Serialize reconciliation and retry incomplete authority checks until reads reopen. */
export function createReconcileScheduler(
  run: (signal: AbortSignal) => Promise<boolean>,
  onError: (err: Error) => void = defaultOnError,
): ReconcileTrigger {
  let running: Promise<void> | null = null
  let activeController: AbortController | null = null
  let followUpRequested = false
  let stopped = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryDelayMs = INITIAL_RETRY_DELAY_MS

  const complete = (released: boolean): void => {
    running = null
    activeController = null
    if (released) retryDelayMs = INITIAL_RETRY_DELAY_MS
    if (!stopped) {
      if (followUpRequested) {
        followUpRequested = false
        trigger()
      } else if (!released) {
        retryTimer = setTimeout(trigger, retryDelayMs)
        retryTimer.unref()
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS)
      }
    }
  }

  const execute = (): Promise<void> => {
    const controller = new AbortController()
    activeController = controller
    // Wrap synchronous throws too, so they follow the same completion path.
    const work = (async () => run(controller.signal))()
    running = work.then(
      (released) => {
        complete(released)
      },
      (err: unknown) => {
        complete(false)
        throw err
      },
    )
    return running
  }

  const trigger = (): void => {
    if (stopped) return
    clearTimeout(retryTimer)
    if (running) {
      followUpRequested = true
      return
    }
    void execute().catch((err: unknown) => {
      if (!stopped) onError(err as Error)
    })
  }

  return Object.assign(trigger, {
    async initialize(): Promise<boolean> {
      if (stopped) return false
      try {
        await (running ?? execute())
      } catch (err) {
        // Shutdown can change stopped while the initial pass is awaited.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!stopped) throw err
      }
      return !stopped
    },
    async stop(): Promise<void> {
      stopped = true
      clearTimeout(retryTimer)
      // Startup or the background trigger owns error reporting.
      await running?.catch(() => {})
    },
    abortActivePass(): void {
      activeController?.abort()
    },
  })
}

function defaultOnError(err: Error): void {
  console.error('reconcile run failed:', err)
}
