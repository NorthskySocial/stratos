import { Redis, type ChainableCommander } from 'ioredis'
import { type Cache, type CachePipeline } from '@northskysocial/stratos-core'

export class RedisCache implements Cache {
  private redis: Redis

  constructor(url: string) {
    this.redis = new Redis(url)
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key)
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.redis.set(key, value, 'EX', ttlSeconds)
    } else {
      await this.redis.set(key, value)
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key)
  }

  async sadd(key: string, ...members: string[]): Promise<void> {
    if (members.length === 0) return
    await this.redis.sadd(key, ...members)
  }

  async sismember(key: string, member: string): Promise<boolean> {
    const result = await this.redis.sismember(key, member)
    return result === 1
  }

  pipeline(): CachePipeline {
    return new RedisCachePipeline(this.redis.pipeline())
  }

  async close(): Promise<void> {
    await this.redis.quit()
  }
}

class RedisCachePipeline implements CachePipeline {
  constructor(private pipeline: ChainableCommander) {}

  del(key: string): this {
    this.pipeline.del(key)
    return this
  }

  sadd(key: string, ...members: string[]): this {
    if (members.length > 0) {
      this.pipeline.sadd(key, ...members)
    }
    return this
  }

  async exec(): Promise<void> {
    await this.pipeline.exec()
  }
}
