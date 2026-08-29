import type { Server as HttpServer } from 'node:http'
import type { Logger } from '@northskysocial/stratos-core'

export interface ShutdownDeps {
  httpServer?: HttpServer | null
  serviceStream?: { stop: () => void | Promise<void> } | null
  actorPool?: { stop: () => Promise<void> } | null
  store?: { close: () => Promise<void> } | null
  logger: Logger
  /** In-flight HTTP drain deadline before open sockets are destroyed. */
  drainTimeoutMs?: number
  exit?: (code: number) => void
}

export type ShutdownHandler = (signal: string) => Promise<void>

const DEFAULT_DRAIN_TIMEOUT_MS = 15_000

/**
 * Build the shutdown sequence: stop accepting connections and drain in-flight
 * requests (destroying stragglers at the deadline), stop the service stream
 * and await its in-flight frame dispatch (bounded by the same deadline),
 * await the actor pool's in-flight commit applies — cursors are durable
 * per-commit, so awaiting the drain IS the cursor flush — then close the DB.
 * A second signal exits immediately as an operator escape hatch.
 *
 * Deps are read at signal time and unset deps are skipped, so one handler
 * installed before startup completes drains exactly what exists when the
 * signal arrives.
 */
export function createShutdownHandler(deps: ShutdownDeps): ShutdownHandler {
  const drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
  const exit = deps.exit ?? ((code: number): void => process.exit(code))
  let shuttingDown = false

  return async (signal: string): Promise<void> => {
    if (shuttingDown) {
      deps.logger.warn({ signal }, 'second shutdown signal; forcing exit')
      exit(1)
      return
    }
    shuttingDown = true
    deps.logger.info({ signal }, 'shutdown started')
    try {
      if (deps.httpServer) {
        await drainHttpServer(deps.httpServer, drainTimeoutMs, deps.logger)
      }
      await stopServiceStream(deps.serviceStream, drainTimeoutMs, deps.logger)
      await deps.actorPool?.stop()
      await deps.store?.close()
      deps.logger.info({ signal }, 'shutdown complete')
      exit(0)
    } catch (err) {
      deps.logger.error({ err }, 'shutdown failed')
      exit(1)
    }
  }
}

export function installShutdownHandlers(deps: ShutdownDeps): void {
  const handler = createShutdownHandler(deps)
  process.on('SIGTERM', () => void handler('SIGTERM'))
  process.on('SIGINT', () => void handler('SIGINT'))
}

/** Log the fatal error, then exit non-zero: state after a panic is unknown. */
export function createPanicHandler(
  logger: Logger,
  exit: (code: number) => void = (code): void => process.exit(code),
): (err: unknown) => void {
  return (err: unknown): void => {
    logger.error({ err }, 'unrecoverable error; exiting')
    exit(1)
  }
}

export function installPanicHandlers(logger: Logger): void {
  const handler = createPanicHandler(logger)
  process.on('unhandledRejection', handler)
  process.on('uncaughtException', handler)
}

async function drainHttpServer(
  server: HttpServer,
  timeoutMs: number,
  logger: Logger,
): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
  // Idle keep-alive sockets are not in-flight work; without this the drain
  // always runs to the deadline when any client used keep-alive.
  server.closeIdleConnections()
  if ((await raceDeadline(closed, timeoutMs)) === 'timeout') {
    logger.warn(
      { timeoutMs },
      'drain deadline expired; destroying open connections',
    )
    server.closeAllConnections()
    await closed
  }
}

/**
 * Await the service stream's in-flight frame dispatch before the store
 * closes, so a late enrollment frame cannot hit a closed DB. A dispatch
 * stuck past the deadline no longer blocks shutdown; the reconnect
 * reconciliation on the next boot recovers the lost event.
 */
async function stopServiceStream(
  stream: ShutdownDeps['serviceStream'],
  timeoutMs: number,
  logger: Logger,
): Promise<void> {
  if (!stream) return
  const stopped = Promise.resolve(stream.stop())
  if ((await raceDeadline(stopped, timeoutMs)) === 'timeout') {
    logger.warn(
      { timeoutMs },
      'service stream drain deadline expired; continuing shutdown',
    )
  }
}

async function raceDeadline(
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<'done' | 'timeout'> {
  let timer!: ReturnType<typeof setTimeout>
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
    timer.unref()
  })
  try {
    return await Promise.race([work.then(() => 'done' as const), deadline])
  } finally {
    clearTimeout(timer)
  }
}
