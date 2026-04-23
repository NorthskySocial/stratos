import { type Cache, type Logger } from '@northskysocial/stratos-core'

export interface AllowListProvider {
  isAllowed(did: string): Promise<boolean>
  refresh(): Promise<void>
}

/**
 * ExternalAllowListProvider implements AllowListProvider by fetching an allowlist from an external source.
 */
export class ExternalAllowListProvider implements AllowListProvider {
  private allowList: Set<string> = new Set()
  private refreshInterval: NodeJS.Timeout | null = null

  constructor(
    private url: string,
    private cache?: Cache,
    private bootstrapName?: string,
    private logger?: Logger,
    private refreshMs: number = 600000, // 10 minutes default
  ) {}

  /**
   * Starts the allowlist provider by refreshing the allowlist and setting up periodic refresh.
   */
  async start() {
    await this.refresh()
    this.refreshInterval = setInterval(
      () => void this.refresh(),
      this.refreshMs,
    )
  }

  /**
   * Stops the allowlist provider by clearing the refresh interval and closing the cache if present.
   */
  async stop() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval)
    }
    if (this.cache) {
      await this.cache.close()
    }
  }

  /**
   * Checks if a DID is allowed based on the allowlist.
   * @param did - The DID to check.
   * @returns True if the DID is allowed, false otherwise.
   */
  async isAllowed(did: string): Promise<boolean> {
    if (this.allowList.has(did)) {
      return true
    }

    if (this.cache && this.bootstrapName) {
      return await this.cache.sismember(this.bootstrapName, did)
    }

    return false
  }

  /**
   * Fetch the external allowlist and update the internal allowlist.
   */
  async refresh(): Promise<void> {
    try {
      this.logger?.info({ url: this.url }, 'refreshing external allowlist')
      const response = await fetch(this.url)
      if (!response.ok) {
        throw new Error(`failed to fetch allowlist: ${response.statusText}`)
      }
      const text = await response.text()
      const dids = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('did:'))

      this.allowList = new Set(dids)
      this.logger?.info({ count: dids.length }, 'external allowlist refreshed')

      if (this.cache && this.bootstrapName && dids.length > 0) {
        this.logger?.info(
          { bootstrapName: this.bootstrapName },
          'bootstrapping valkey allowlist',
        )
        // Use a pipeline or transaction for efficiency
        const pipeline = this.cache.pipeline()
        pipeline.del(this.bootstrapName)
        const chunkSize = 1000
        for (let i = 0; i < dids.length; i += chunkSize) {
          pipeline.sadd(this.bootstrapName, ...dids.slice(i, i + chunkSize))
        }
        await pipeline.exec()
      }
    } catch (err) {
      this.logger?.error(
        { err: err instanceof Error ? err.message : String(err) },
        'failed to refresh external allowlist',
      )
    }
  }
}
