import {
  createFeedgenMetrics,
  type SubscriptionStatus,
} from '../src/metrics.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoundaryCatalog } from '../src/feeds/catalog.js'
import {
  parseBoundaryCatalog,
  type CatalogBoundary,
  MAX_CATALOG_BOUNDARIES,
} from '../src/feeds/catalog-model.js'
import { loadBoundaryCatalogOptions } from '../src/feeds/catalog-options.js'

const AUTHORITY = 'did:web:nerv.example'
const PILOTS = `${AUTHORITY}/pilots`
function entry(overrides: Partial<CatalogBoundary> = {}): CatalogBoundary {
  return {
    boundary: PILOTS,
    roomId: 'pilots',
    displayName: 'Pilots',
    description: 'NERV pilots',
    listed: true,
    joinable: true,
    revision: 1,
    ...overrides,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture() {
  const configuredBoundaries = new Set<string>()
  const client = {
    listBoundaries: vi
      .fn<(signal: AbortSignal) => Promise<CatalogBoundary[]>>()
      .mockResolvedValue([entry()]),
  }
  const suspend = vi.fn(async () => {})
  const apply = vi.fn(
    async (
      _previous: readonly CatalogBoundary[],
      next: readonly CatalogBoundary[],
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted()
      for (const row of next) configuredBoundaries.add(row.boundary)
    },
  )
  const onError = vi.fn()
  const options = {
    mode: 'upstream' as const,
    refreshMs: 1000,
    maxAgeMs: 3000,
    requestTimeoutMs: 500,
    applyTimeoutMs: 10_000,
  }
  const catalog = new BoundaryCatalog({
    configuredBoundaries,
    client,
    suspend,
    apply,
    onError,
    options,
  })
  return { catalog, client, suspend, apply, configuredBoundaries, onError }
}
const active: BoundaryCatalog[] = []
afterEach(async () => {
  for (const catalog of active.splice(0)) await catalog.stop()
  vi.useRealTimers()
})
function trackedFixture() {
  const result = fixture()
  active.push(result.catalog)
  return result
}

describe('boundary catalogue refresh', () => {
  it('starts closed, confirms first reconciliation, and keeps unlisted closed-joining feeds addressable', async () => {
    const { catalog, client, configuredBoundaries, apply } = trackedFixture()
    client.listBoundaries.mockResolvedValue([
      entry({ listed: false, joinable: false }),
    ])
    expect(catalog.isReady()).toBe(false)
    expect(catalog.list()).toEqual([])
    expect(catalog.get('pilots')).toBeUndefined()
    await catalog.start()
    expect(client.listBoundaries).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledOnce()
    expect(apply.mock.calls[0][0]).toEqual([])
    expect(catalog.isReady()).toBe(true)
    expect(catalog.list()).toEqual([])
    expect(catalog.get('pilots')).toEqual({
      id: 'pilots',
      boundary: PILOTS,
      displayName: 'Pilots',
      description: 'NERV pilots',
    })
    expect([...configuredBoundaries]).toEqual([PILOTS])
  })

  it('updates discovery metadata only after applying revisions and preserves object identity on unchanged refreshes', async () => {
    const { catalog, client, apply } = trackedFixture()
    await catalog.start()
    const first = catalog.get('pilots')
    expect(catalog.list()).toEqual([first])
    await catalog.refresh()
    expect(catalog.get('pilots')).toBe(first)
    expect(apply).toHaveBeenCalledOnce()
    client.listBoundaries.mockResolvedValue([
      entry({ revision: 2, displayName: 'NERV' }),
    ])
    await catalog.refresh()
    expect(catalog.get('pilots')).not.toBe(first)
    expect(catalog.get('pilots')?.displayName).toBe('NERV')
    expect(apply.mock.calls[1][0]).toEqual([entry()])
  })

  it('removes boundaries without leaving the shared replay scope populated', async () => {
    const { catalog, client, configuredBoundaries } = trackedFixture()
    await catalog.start()
    client.listBoundaries.mockResolvedValue([])
    await catalog.refresh()
    expect(catalog.isReady()).toBe(true)
    expect(catalog.get('pilots')).toBeUndefined()
    expect([...configuredBoundaries]).toEqual([])
  })

  it('closes reads and sync scope on failure, then retries unchanged authority state', async () => {
    const { catalog, client, configuredBoundaries, apply, suspend, onError } =
      trackedFixture()
    await catalog.start()
    client.listBoundaries.mockRejectedValueOnce(new Error('authority offline'))
    await catalog.refresh()
    expect(catalog.isReady()).toBe(false)
    expect(catalog.list()).toEqual([])
    expect(configuredBoundaries.size).toBe(0)
    expect(suspend).toHaveBeenCalledTimes(2)
    expect(onError.mock.calls[0][0].message).toBe('authority offline')
    await catalog.refresh()
    expect(catalog.isReady()).toBe(true)
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('serializes overlapping refreshes and blocks reads throughout asynchronous application', async () => {
    const { catalog, client, apply } = trackedFixture()
    await catalog.start()
    client.listBoundaries.mockResolvedValue([entry({ revision: 2 })])
    const pending = deferred<void>()
    apply.mockImplementationOnce(async () => pending.promise)
    const first = catalog.refresh()
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2))
    const second = catalog.refresh()
    expect(second).toBe(first)
    expect(catalog.isReady()).toBe(false)
    pending.resolve()
    await first
    expect(catalog.isReady()).toBe(true)
  })

  it('rejects a changed confirmation instead of publishing a stale reconciliation', async () => {
    const { catalog, client, onError, configuredBoundaries } = trackedFixture()
    client.listBoundaries
      .mockResolvedValueOnce([entry()])
      .mockResolvedValueOnce([entry({ revision: 2 })])
    await catalog.start()
    expect(catalog.isReady()).toBe(false)
    expect(configuredBoundaries.size).toBe(0)
    expect(onError.mock.calls[0][0].message).toBe(
      'Boundary catalogue changed during reconciliation',
    )
  })

  it.each([
    { boundary: `${AUTHORITY}/command`, revision: 2 },
    { roomId: 'command', revision: 2 },
    { revision: 1, description: 'Changed without revision' },
    { revision: 0 },
  ])(
    'rejects mapping or revision rollback after disappearance: %s',
    async (changes) => {
      const { catalog, client, onError } = trackedFixture()
      await catalog.start()
      client.listBoundaries.mockResolvedValue([])
      await catalog.refresh()
      client.listBoundaries.mockResolvedValue([entry(changes)])
      await catalog.refresh()
      expect(catalog.isReady()).toBe(false)
      expect(onError.mock.calls[0][0].message).toMatch(
        /Boundary catalogue (reassigned a stable room ID|revision did not advance)/,
      )
    },
  )

  it('expires a stalled authority fetch and periodically retries with bounded requests', async () => {
    vi.useFakeTimers()
    const { catalog, client, configuredBoundaries, onError } = trackedFixture()
    await catalog.start()
    client.listBoundaries.mockImplementation(
      (signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        ),
    )
    await vi.advanceTimersByTimeAsync(3000)
    expect(catalog.isReady()).toBe(false)
    expect(configuredBoundaries.size).toBe(0)
    expect(onError).toHaveBeenCalled()
    client.listBoundaries.mockResolvedValue([entry()])
    await vi.advanceTimersByTimeAsync(1000)
    expect(catalog.isReady()).toBe(true)
  })

  it('reports expiry drain failures while keeping the catalogue closed', async () => {
    vi.useFakeTimers()
    const { catalog, client, suspend, onError } = trackedFixture()
    await catalog.start()
    const failure = new Error('expiry drain failed')
    suspend.mockRejectedValueOnce(failure)
    client.listBoundaries.mockImplementation(
      (signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        ),
    )
    await vi.advanceTimersByTimeAsync(3000)
    expect(catalog.isReady()).toBe(false)
    expect(onError).toHaveBeenCalledWith(failure)
    client.listBoundaries.mockResolvedValue([entry()])
    await vi.advanceTimersByTimeAsync(1000)
    expect(catalog.isReady()).toBe(true)
  })

  it('aborts a stalled catalogue application within its independent budget', async () => {
    const configuredBoundaries = new Set<string>()
    const onError = vi.fn()
    const catalog = new BoundaryCatalog({
      configuredBoundaries,
      client: { listBoundaries: async () => [entry()] },
      options: {
        mode: 'upstream',
        refreshMs: 1000,
        maxAgeMs: 3000,
        requestTimeoutMs: 500,
        applyTimeoutMs: 10,
      },
      suspend: async () => {},
      onError,
      apply: async (_previous, _next, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        ),
    })
    active.push(catalog)
    await catalog.start()
    expect(catalog.isReady()).toBe(false)
    expect(onError.mock.calls[0][0].name).toBe('TimeoutError')
  })

  it('uses the freshness clock even when expiry timers have not executed', async () => {
    vi.useFakeTimers()
    const { catalog } = trackedFixture()
    await catalog.start()
    vi.setSystemTime(Date.now() + 3000)
    expect(catalog.isReady()).toBe(false)
    expect(catalog.get('pilots')).toBeUndefined()
  })

  it('stop cancels a request and cannot be reversed by a late response or another start', async () => {
    vi.useFakeTimers()
    const { catalog, client, onError } = trackedFixture()
    const pending = deferred<CatalogBoundary[]>()
    client.listBoundaries.mockReturnValue(pending.promise)
    const starting = catalog.start()
    const stopping = catalog.stop()
    pending.resolve([entry()])
    await Promise.all([starting, stopping])
    expect(vi.getTimerCount()).toBe(0)
    await catalog.start()
    await catalog.refresh()
    expect(catalog.isReady()).toBe(false)
    expect(client.listBoundaries).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
  })

  it('stopping before startup and refreshing before startup never contact authority', async () => {
    const { catalog, client } = trackedFixture()
    await catalog.refresh()
    await catalog.stop()
    await catalog.start()
    expect(client.listBoundaries).not.toHaveBeenCalled()
  })

  it('reports failed cleanup and remains closed, then recovers on retry', async () => {
    const { catalog, suspend, onError } = trackedFixture()
    suspend
      .mockRejectedValueOnce(new Error('drain failed'))
      .mockRejectedValueOnce(new Error('second drain failed'))
    await catalog.start()
    expect(onError.mock.calls.map(([error]) => error.message)).toEqual([
      'second drain failed',
      'drain failed',
    ])
    expect(catalog.isReady()).toBe(false)
    await catalog.refresh()
    expect(catalog.isReady()).toBe(true)
  })
})

describe('catalogue validation', () => {
  it('accepts authority-qualified records and sorts stable room IDs', () => {
    expect(
      parseBoundaryCatalog(
        {
          boundaries: [
            entry({ roomId: 'z' }),
            entry({ roomId: 'A.command', boundary: `${AUTHORITY}/command` }),
          ],
        },
        AUTHORITY,
      ).map((row) => row.roomId),
    ).toEqual(['A.command', 'z'])
  })
  it('accepts the exact boundary-count ceiling without truncation', () => {
    const boundaries = Array.from({ length: MAX_CATALOG_BOUNDARIES }, (_, i) =>
      entry({ roomId: `room-${i}`, boundary: `${AUTHORITY}/room-${i}` }),
    )
    expect(parseBoundaryCatalog({ boundaries }, AUTHORITY)).toHaveLength(
      MAX_CATALOG_BOUNDARIES,
    )
  })
  it.each([
    null,
    undefined,
    {},
    { boundaries: null },
    { boundaries: Array(MAX_CATALOG_BOUNDARIES + 1).fill(entry()) },
  ])('rejects invalid or unbounded catalogue shape %s', (value) => {
    expect(() => parseBoundaryCatalog(value, AUTHORITY)).toThrow(
      'Invalid boundary catalogue',
    )
  })
  it.each([null, 42, 'rei'])('rejects non-object entries %s', (value) => {
    expect(() =>
      parseBoundaryCatalog({ boundaries: [value] }, AUTHORITY),
    ).toThrow('Invalid catalogue entry')
  })
  it.each([
    undefined,
    42,
    'pilots',
    'did:web:seele.example/pilots',
    `${AUTHORITY}/bad/path`,
  ])('rejects unqualified, malformed, or foreign authority %s', (boundary) => {
    expect(() =>
      parseBoundaryCatalog(
        { boundaries: [{ ...entry(), boundary }] },
        AUTHORITY,
      ),
    ).toThrow('Invalid catalogue boundary authority')
  })
  it.each([undefined, 42, '', '  '])('rejects invalid room ID %s', (roomId) => {
    expect(() =>
      parseBoundaryCatalog({ boundaries: [{ ...entry(), roomId }] }, AUTHORITY),
    ).toThrow('Invalid catalogue room ID')
  })
  it.each([
    { displayName: 1 },
    { description: 1 },
    { listed: 1 },
    { joinable: 1 },
    { revision: 0 },
    { revision: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid metadata %s', (changes) => {
    expect(() =>
      parseBoundaryCatalog(
        { boundaries: [{ ...entry(), ...changes }] },
        AUTHORITY,
      ),
    ).toThrow('Invalid catalogue metadata')
  })
  it.each([
    entry(),
    entry({ roomId: 'command' }),
    entry({ boundary: `${AUTHORITY}/command` }),
  ])('rejects duplicate ID or boundary mappings', (duplicate) => {
    expect(() =>
      parseBoundaryCatalog({ boundaries: [entry(), duplicate] }, AUTHORITY),
    ).toThrow('Duplicate catalogue mapping')
  })
})

describe('catalogue options', () => {
  it('defaults to upstream authority and permits explicit static migration mode', () => {
    expect(loadBoundaryCatalogOptions({})).toEqual({
      mode: 'upstream',
      refreshMs: 30000,
      maxAgeMs: 60000,
      requestTimeoutMs: 10000,
      applyTimeoutMs: 120000,
    })
    expect(
      loadBoundaryCatalogOptions({ FEEDGEN_BOUNDARY_CATALOG_MODE: 'static' })
        .mode,
    ).toBe('static')
  })
  it('accepts valid bounds and rejects refresh periods that outlive freshness', () => {
    expect(
      loadBoundaryCatalogOptions({
        FEEDGEN_BOUNDARY_CATALOG_REFRESH_MS: '1000',
        FEEDGEN_BOUNDARY_CATALOG_MAX_AGE_MS: '300000',
        FEEDGEN_BOUNDARY_CATALOG_REQUEST_TIMEOUT_MS: '2000',
        FEEDGEN_BOUNDARY_CATALOG_APPLY_TIMEOUT_MS: '5000',
      }),
    ).toEqual({
      mode: 'upstream',
      refreshMs: 1000,
      maxAgeMs: 300000,
      requestTimeoutMs: 2000,
      applyTimeoutMs: 5000,
    })
    expect(() =>
      loadBoundaryCatalogOptions({
        FEEDGEN_BOUNDARY_CATALOG_REFRESH_MS: '60000',
      }),
    ).toThrow('Boundary catalogue refresh must be shorter than maximum age')
  })
  it.each(['0', '999', '300001', '1.5', 'NaN'])(
    'rejects invalid duration %s',
    (value) => {
      expect(() =>
        loadBoundaryCatalogOptions({
          FEEDGEN_BOUNDARY_CATALOG_REFRESH_MS: value,
        }),
      ).toThrow(
        'Boundary catalogue durations must be integers from 1000 through 300000 ms',
      )
    },
  )
  it('rejects unknown mode', () => {
    expect(() =>
      loadBoundaryCatalogOptions({ FEEDGEN_BOUNDARY_CATALOG_MODE: 'auto' }),
    ).toThrow('FEEDGEN_BOUNDARY_CATALOG_MODE must be upstream or static')
  })
})

describe('catalogue-aware readiness metrics', () => {
  it('observes the complete readiness gate and retains legacy fallback', () => {
    let collect!: (result: {
      observe: (instrument: string, value: number) => void
    }) => void
    const meter = {
      createCounter: () => ({ add: vi.fn() }),
      createUpDownCounter: () => ({ add: vi.fn() }),
      createHistogram: () => ({ record: vi.fn() }),
      createObservableGauge: (name: string) => name,
      addBatchObservableCallback: (callback: typeof collect) => {
        collect = callback
      },
    }
    const status: SubscriptionStatus = { actorPool: null, serviceStream: null }
    const metrics = createFeedgenMetrics(status, meter as never)
    const observe = vi.fn()
    const read = () => {
      observe.mockClear()
      collect({ observe })
      return observe.mock.calls.find(
        ([name]) => name === 'stratos.feedgen.ready',
      )?.[1]
    }
    expect(read()).toBe(0)
    metrics.setReady(true)
    expect(read()).toBe(1)
    status.isReady = () => false
    expect(read()).toBe(0)
    status.isReady = () => true
    metrics.setReady(false)
    expect(read()).toBe(1)
  })
})
