import { Redis } from 'ioredis'
import { type Logger } from '@northskysocial/stratos-core'

export interface AllowListProvider {
  isAllowed(did: string): Promise<boolean>
  refresh(): Promise<void>
}

export class ExternalAllowListProvider implements AllowListProvider {
  private readonly redis: Redis | null = null
  private allowList: Set<string> = new Set()
  private refreshInterval: NodeJS.Timeout | null = null

  constructor(
    private url: string,
    private valkeyUrl?: string,
    private bootstrapName?: string,
    private logger?: Logger,
    private refreshMs: number = 600000, // 10 minutes default
  ) {
    if (this.valkeyUrl) {
      this.redis = new Redis(this.valkeyUrl)
    }
  }

  async start() {
    await this.refresh()
    this.refreshInterval = setInterval(() => this.refresh(), this.refreshMs)
  }

  async stop() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval)
    }
    if (this.redis) {
      await this.redis.quit()
    }
  }

  async isAllowed(did: string): Promise<boolean> {
    if (this.allowList.has(did)) {
      return true
    }

    if (this.redis && this.bootstrapName) {
      const exists = await this.redis.sismember(this.bootstrapName, did)
      return exists === 1
    }

    return false
  }

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

      if (this.redis && this.bootstrapName && dids.length > 0) {
        this.logger?.info(
          { bootstrapName: this.bootstrapName },
          'bootstrapping valkey allow list',
        )
        // Use a pipeline or transaction for efficiency
        const pipeline = this.redis.pipeline()
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
