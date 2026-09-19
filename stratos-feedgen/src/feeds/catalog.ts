import type { FeedDescription, FeedRegistry } from './config.js'
import type { FeedReadiness } from '../readiness.js'
import { parseBoundaryCatalog, type CatalogBoundary } from './catalog-model.js'
import type { BoundaryCatalogOptions } from './catalog-options.js'

export interface BoundaryCatalogDeps {
  authority: string
  client: {
    listBoundaries: (signal: AbortSignal) => Promise<CatalogBoundary[]>
  }
  configuredBoundaries: Set<string>
  options: BoundaryCatalogOptions
  apply: (
    previous: readonly CatalogBoundary[],
    next: readonly CatalogBoundary[],
    signal: AbortSignal,
  ) => Promise<void>
  baseline?: {
    load: () => Promise<CatalogBoundary[]>
    save: (entries: readonly CatalogBoundary[]) => Promise<void>
  }
  suspend: () => Promise<void>
  onError: (error: unknown) => void
  now?: () => number
}

/** The authority snapshot and its freshness lease are one read admission gate. */
export class BoundaryCatalog implements FeedRegistry, FeedReadiness {
  private entries: CatalogBoundary[] = []
  private readonly known = new Map<string, CatalogBoundary>()
  private feeds = new Map<string, FeedDescription>()
  private validUntil = Number.NEGATIVE_INFINITY
  private stopped = false
  private started = false
  private running: Promise<void> | undefined
  private controller = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private expiry: ReturnType<typeof setTimeout> | undefined
  private suspension = Promise.resolve()
  private readonly now: () => number

  constructor(private readonly deps: BoundaryCatalogDeps) {
    this.now = deps.now ?? Date.now
  }

  isReady(): boolean {
    return this.now() < this.validUntil
  }

  list(): FeedDescription[] {
    if (!this.isReady()) return []
    return this.entries.filter((entry) => entry.listed).map(toFeedDescription)
  }

  get(id: string): FeedDescription | undefined {
    return this.isReady() ? this.feeds.get(id) : undefined
  }

  start(): Promise<void> {
    this.started = true
    if (!this.deps.baseline) return this.refresh()
    return this.deps.baseline
      .load()
      .then((entries) => {
        this.restoreBaseline(entries)
        return this.refresh()
      })
      .catch(async (error: unknown) => {
        this.deps.onError(error)
        await this.suspend()
      })
  }

  refresh(): Promise<void> {
    if (this.stopped || !this.started) return Promise.resolve()
    if (this.running) return this.running
    clearTimeout(this.timer)
    const controller = new AbortController()
    this.controller = controller
    this.running = this.execute(controller.signal).finally(() => {
      this.running = undefined
      if (!this.stopped) {
        this.timer = setTimeout(
          () => void this.refresh(),
          this.deps.options.refreshMs,
        )
        this.timer.unref()
      }
    })
    return this.running
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    this.controller.abort()
    this.close()
    await this.running
    await this.suspend()
  }

  private async fetch(signal: AbortSignal): Promise<CatalogBoundary[]> {
    const entries = await this.deps.client.listBoundaries(
      AbortSignal.any([
        signal,
        AbortSignal.timeout(this.deps.options.requestTimeoutMs),
      ]),
    )
    signal.throwIfAborted()
    this.validateHistory(entries)
    return entries
  }

  private async execute(signal: AbortSignal): Promise<void> {
    try {
      let next = await this.fetch(signal)
      if (
        !this.isReady() ||
        JSON.stringify(next) !== JSON.stringify(this.entries)
      ) {
        this.close()
        await this.suspend()
        signal.throwIfAborted()
        const applySignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(this.deps.options.applyTimeoutMs),
        ])
        await this.deps.apply(this.entries, next, applySignal)
        applySignal.throwIfAborted()
        signal.throwIfAborted()
        // A long reconciliation cannot publish an authority snapshot that expired while it ran.
        const confirmed = await this.fetch(signal)
        if (JSON.stringify(confirmed) !== JSON.stringify(next))
          throw new Error('Boundary catalogue changed during reconciliation')
        next = confirmed
        await this.deps.baseline?.save(next)
        this.feeds = new Map(
          next.map((entry) => [entry.roomId, toFeedDescription(entry)]),
        )
      }
      signal.throwIfAborted()
      this.entries = next
      for (const entry of next) this.known.set(entry.roomId, entry)
      this.validUntil = this.now() + this.deps.options.maxAgeMs
      clearTimeout(this.expiry)
      this.expiry = setTimeout(() => {
        this.close()
        this.controller.abort()
        void this.suspend().catch((error) => this.deps.onError(error))
      }, this.deps.options.maxAgeMs)
      this.expiry.unref()
    } catch (error) {
      this.close()
      try {
        await this.suspend()
      } catch (suspendError) {
        this.deps.onError(suspendError)
      }
      if (!this.stopped) this.deps.onError(error)
    }
  }

  private close(): void {
    this.validUntil = Number.NEGATIVE_INFINITY
    clearTimeout(this.expiry)
    this.deps.configuredBoundaries.clear()
  }

  private suspend(): Promise<void> {
    this.suspension = this.suspension
      .catch(() => {})
      .then(() => this.deps.suspend())
    return this.suspension
  }

  private validateHistory(entries: readonly CatalogBoundary[]): void {
    const priorBoundaries = new Map(
      [...this.known.values()].map((entry) => [entry.boundary, entry.roomId]),
    )
    for (const entry of entries) {
      const prior = this.known.get(entry.roomId)
      if (
        (prior && prior.boundary !== entry.boundary) ||
        (priorBoundaries.has(entry.boundary) &&
          priorBoundaries.get(entry.boundary) !== entry.roomId)
      )
        throw new Error('Boundary catalogue reassigned a stable room ID')
      if (
        prior &&
        (entry.revision < prior.revision ||
          (entry.revision === prior.revision &&
            JSON.stringify(entry) !== JSON.stringify(prior)))
      )
        throw new Error('Boundary catalogue revision did not advance')
    }
  }

  private restoreBaseline(entries: readonly CatalogBoundary[]): void {
    let validated: CatalogBoundary[]
    try {
      validated = parseBoundaryCatalog(
        { boundaries: entries },
        this.deps.authority,
      )
    } catch {
      throw new Error('Invalid persisted boundary catalogue')
    }
    for (const entry of validated) this.known.set(entry.roomId, entry)
    this.entries = validated
  }
}

function toFeedDescription(entry: CatalogBoundary): FeedDescription {
  return {
    id: entry.roomId,
    boundary: entry.boundary,
    displayName: entry.displayName,
    description: entry.description,
  }
}
