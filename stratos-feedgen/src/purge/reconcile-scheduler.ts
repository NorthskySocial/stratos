export interface ReconcileTrigger {
  (): void
  stop: () => Promise<void>
}

const INITIAL_RETRY_DELAY_MS = 5_000
const MAX_RETRY_DELAY_MS = 60_000

/** Serialize reconciliation and retry incomplete authority checks until reads reopen. */
export function createReconcileScheduler(
  run: () => Promise<boolean>,
  onError: (err: Error) => void = defaultOnError,
): ReconcileTrigger {
  let running: Promise<void> | null = null
  let followUpRequested = false
  let stopped = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryDelayMs = INITIAL_RETRY_DELAY_MS

  const execute = async (): Promise<boolean> => {
    try {
      return await run()
    } catch (err) {
      onError(err as Error)
      return false
    }
  }

  const trigger = (): void => {
    if (stopped) return
    clearTimeout(retryTimer)
    if (running) {
      followUpRequested = true
      return
    }
    running = execute().then((released) => {
      running = null
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
    })
  }

  return Object.assign(trigger, {
    async stop(): Promise<void> {
      stopped = true
      clearTimeout(retryTimer)
      await running
    },
  })
}

function defaultOnError(err: Error): void {
  console.error('reconcile run failed:', err)
}
