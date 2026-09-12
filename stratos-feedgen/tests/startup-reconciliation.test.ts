import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ShutdownDeps,
  ShutdownHandler,
} from '../src/lifecycle/shutdown.js'

const state = vi.hoisted(() => ({
  deps: undefined as ShutdownDeps | undefined,
  shutdown: undefined as ShutdownHandler | undefined,
  exit: vi.fn<typeof process.exit>(),
  error: vi.fn(),
  close: vi.fn(async () => {}),
}))

vi.mock('../src/observability/instrumentation.js', () => ({}))
vi.mock('../src/observability/runtime.js', () => ({
  captureUnexpectedError: vi.fn(),
  shutdownTelemetry: vi.fn(async () => {}),
}))
vi.mock('../src/config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/config.js')>()
  return {
    ...original,
    loadFeedgenConfig: () =>
      original.loadFeedgenConfig({
        FEEDGEN_SERVICE_DID: 'did:web:feedgen.bebop.test',
        FEEDGEN_SIGNING_KEY: '1'.repeat(64),
        STRATOS_SERVICE_URL: 'https://stratos.bebop.test',
        STRATOS_SERVICE_DID: 'did:web:stratos.bebop.test',
        FEEDGEN_SPACE_SYNC_ENABLED: 'true',
        FEEDGEN_MEMBERSHIP_SQLITE_PATH:
          '/tmp/feedgen-bebop-startup-test.sqlite',
      }),
  }
})
vi.mock('../src/db/index.js', () => ({
  createFeedgenStore: async () => ({
    listEnrolledActors: async () => [
      {
        did: 'did:plc:spikespiegel',
        boundaries: [],
        enrolledAt: '2024-01-01T00:00:00.000Z',
        lastSeenAt: '2024-01-01T00:00:00.000Z',
      },
    ],
    close: state.close,
  }),
}))
vi.mock('../src/feeds/index.js', () => ({
  loadFeedRegistry: () => ({ list: () => [] }),
}))
vi.mock('../src/server.js', () => ({
  createFeedgenServer: () => ({ listen: async () => undefined }),
}))
vi.mock('../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: state.error,
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}))
vi.mock('../src/lifecycle/shutdown.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../src/lifecycle/shutdown.js')>()
  return {
    ...original,
    installPanicHandlers: vi.fn(),
    createShutdownHandler: (deps: ShutdownDeps) => {
      deps.drainTimeoutMs = 50
      deps.exit = state.exit
      state.deps = deps
      state.shutdown = original.createShutdownHandler(deps)
      return state.shutdown
    },
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('startup reconciliation ownership', () => {
  it.each([true, false])(
    'owns the initial fetch and only continues startup if shutdown has not interrupted it (interrupted: %s)',
    async (interrupted) => {
      // This harness owns the legacy static startup; the catalogue CLI smoke
      // covers authoritative discovery and refresh against a local authority.
      vi.stubEnv('FEEDGEN_BOUNDARY_CATALOG_MODE', 'static')
      vi.resetModules()
      vi.clearAllMocks()
      const { ActorPool, ServiceStream } =
        await import('../src/subscription/index.js')
      const { SpaceSyncScheduler } = await import('../src/space-sync/index.js')
      const { UpstreamStratosClient } = await import('../src/upstream/index.js')
      vi.useFakeTimers()
      vi.spyOn(process, 'exit').mockImplementation(state.exit)
      // Exercise the entry point without registering process-wide signal handlers.
      const processOn = process.on.bind(process)
      vi.spyOn(process, 'on').mockImplementation((event, listener) => {
        if (event === 'SIGTERM' || event === 'SIGINT') return process
        return processOn(event, listener)
      })
      vi.spyOn(ActorPool.prototype, 'start').mockImplementation(() => {})
      const seed = vi
        .spyOn(ActorPool.prototype, 'seedFromStore')
        .mockResolvedValue(0)
      vi.spyOn(ActorPool.prototype, 'stop').mockResolvedValue()
      const serviceStart = vi
        .spyOn(ServiceStream.prototype, 'start')
        .mockImplementation(() => {})
      const spaceStart = vi
        .spyOn(SpaceSyncScheduler.prototype, 'start')
        .mockImplementation(() => {})
      let finish!: () => void
      let signal: AbortSignal | undefined
      const fetch = vi
        .spyOn(UpstreamStratosClient.prototype, 'resolveEnrollments')
        .mockImplementation((_did, current) => {
          signal = current
          return new Promise((resolve, reject) => {
            finish = () =>
              resolve({
                did: 'did:plc:spikespiegel',
                enrolled: true,
                boundaries: [],
              })
            current?.addEventListener('abort', () => reject(current.reason), {
              once: true,
            })
          })
        })
      await import('../src/bin/main.js')
      await vi.waitFor(() => {
        expect(state.error.mock.calls).toEqual([])
        expect(fetch).toHaveBeenCalledOnce()
      })
      expect(state.deps?.reconcileScheduler).toBeDefined()
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(seed).not.toHaveBeenCalled()
      if (!interrupted) {
        finish()
        await vi.waitFor(() => expect(spaceStart).toHaveBeenCalledOnce())
        expect(seed).toHaveBeenCalledOnce()
        expect(serviceStart).toHaveBeenCalledOnce()
        await state.shutdown!('SIGTERM')
        expect(signal!.aborted).toBe(false)
        expect(state.close).toHaveBeenCalledOnce()
        expect(state.exit).toHaveBeenCalledExactlyOnceWith(0)
        return
      }
      const stopping = state.shutdown!('SIGTERM')
      await vi.advanceTimersByTimeAsync(49)
      expect(signal!.aborted).toBe(false)
      expect(state.close).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await stopping
      expect(signal!.aborted).toBe(true)
      expect(seed).not.toHaveBeenCalled()
      expect(serviceStart).not.toHaveBeenCalled()
      expect(spaceStart).not.toHaveBeenCalled()
      expect(state.close).toHaveBeenCalledOnce()
      expect(state.exit).toHaveBeenCalledExactlyOnceWith(0)
    },
  )
})
