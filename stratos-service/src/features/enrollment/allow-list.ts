import { type Cache, type Logger } from '@northskysocial/stratos-core'

export interface AllowListProvider {
  isAllowed(did: string): Promise<boolean>
  refresh(): Promise<void>
}

/**
 * ExternalAllowListProvider implements AllowListProvider by fetching an allow list from an external source.
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
   * Starts the allow list provider by refreshing the allow list and setting up periodic refresh.
   */
  async start() {
    await this.refresh()
    this.refreshInterval = setInterval(
      () => void this.refresh(),
      this.refreshMs,
    )
  }

  /**
   * Stops the allow list provider by clearing the refresh interval and closing the cache if present.
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
   * Checks if a DID is allowed based on the allow list.
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
   * Fetch the external allow list and update the internal allow list.
   */
  async refresh(): Promise<void> {
    try {
      this.logger?.info({ url: this.url }, 'refreshing external allow list')
      const response = await fetch(this.url)
      if (!response.ok) {
        throw new Error(`failed to fetch allow list: ${response.statusText}`)
      }
      const text = await response.text()
      const dids = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('did:'))

      this.allowList = new Set(dids)
      this.logger?.info({ count: dids.length }, 'external allow list refreshed')

      if (this.cache && this.bootstrapName && dids.length > 0) {
        this.logger?.info(
          { bootstrapName: this.bootstrapName },
          'bootstrapping valkey allow list',
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
        'failed to refresh external allow list',
      )
    }
  }
}
