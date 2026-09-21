import type {
  ProjectionCompactionResult,
  ProjectionCompactionStore,
} from '../db/types.js'

const MAX_PASSES_PER_RUN = 4
const DEFAULT_INTERVAL_MS = 60_000

export interface ProjectionCompactorDeps {
  store: ProjectionCompactionStore
  intervalMs?: number
  onError?: (error: unknown) => void
  onResult?: (result: ProjectionCompactionResult) => void
  evictBlobCacheEntries?: (keys: readonly string[]) => Promise<void>
}

/** Schedules short retention passes without monopolizing the SQLite writer. */
export class ProjectionCompactor {
  private readonly intervalMs: number
  private readonly onError: (error: unknown) => void
  private readonly onResult: (result: ProjectionCompactionResult) => void
  private timer: NodeJS.Timeout | undefined
  private active: Promise<void> | undefined

  constructor(private readonly deps: ProjectionCompactorDeps) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
    this.onError = deps.onError ?? (() => {})
    this.onResult = deps.onResult ?? (() => {})
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.run(), this.intervalMs)
    this.timer.unref()
  }

  async run(): Promise<void> {
    if (this.active) return this.active
    this.active = this.runBounded()
      .catch((error: unknown) => {
        this.onError(error)
      })
      .finally(() => {
        this.active = undefined
      })
    return this.active
  }

  /** Runs a startup pass and propagates a failure before the service is ready. */
  async runRequired(): Promise<void> {
    if (this.active) return this.active
    this.active = this.runBounded().finally(() => {
      this.active = undefined
    })
    return this.active
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.active
  }

  private async runBounded(): Promise<void> {
    for (let pass = 0; pass < MAX_PASSES_PER_RUN; pass += 1) {
      const result = await this.deps.store.compactProjection()
      await this.evictBlobCacheEntries(result.blobCacheKeys)
      this.onResult({
        posts: result.posts,
        blobCacheEntries: result.blobCacheEntries,
        syncCursors: result.syncCursors,
        spaceCursors: result.spaceCursors,
        stagedRecords: result.stagedRecords,
        pendingVerifications: result.pendingVerifications,
        hasMore: result.hasMore,
      })
      if (!result.hasMore) return
    }
  }

  private async evictBlobCacheEntries(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return
    if (
      !this.deps.evictBlobCacheEntries ||
      !this.deps.store.completeBlobCacheEvictions
    ) {
      throw new Error('durable blob cache eviction is not configured')
    }
    await this.deps.evictBlobCacheEntries(keys)
    await this.deps.store.completeBlobCacheEvictions(keys)
  }
}
