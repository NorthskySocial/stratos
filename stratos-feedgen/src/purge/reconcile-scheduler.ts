export type ReconcileTrigger = () => void

/**
 * Serializes reconcile runs: a trigger during an in-flight run is coalesced
 * into exactly one follow-up run, so a reconnect storm cannot stack N
 * concurrent reconciles. Rejections are reported via `onError`, never thrown —
 * the next trigger retries.
 */
export function createReconcileScheduler(
  run: () => Promise<void>,
  onError: (err: Error) => void = defaultOnError,
): ReconcileTrigger {
  let running = false
  let followUpRequested = false

  const launch = (): void => {
    running = true
    run()
      .catch((err: unknown) => onError(err as Error))
      .finally(() => {
        running = false
        if (followUpRequested) {
          followUpRequested = false
          launch()
        }
      })
  }

  return () => {
    if (running) {
      followUpRequested = true
      return
    }
    launch()
  }
}

function defaultOnError(err: Error): void {
  console.error('reconcile run failed:', err)
}
