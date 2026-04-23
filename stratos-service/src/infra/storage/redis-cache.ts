import { type ChainableCommander, Redis } from 'ioredis'
import { type Cache, type CachePipeline } from '@northskysocial/stratos-core'

/**
 * RedisCache implements the Cache interface using Redis as the underlying storage.
 */
export class RedisCache implements Cache {
  private redis: Redis

  constructor(url: string) {
    this.redis = new Redis(url)
  }

  /**
   * Get a value from the cache.
   * @param key - The key to retrieve.
   * @returns The value associated with the key, or null if not found.
   */
  async get(key: string): Promise<string | null> {
    return this.redis.get(key)
  }

  /**
   * Set a value in the cache with optional TTL.
   * @param key - The key to set.
   * @param value - The value to set.
   * @param ttlSeconds - Optional TTL in seconds for the cache entry.
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.redis.set(key, value, 'EX', ttlSeconds)
    } else {
      await this.redis.set(key, value)
    }
  }

  /**
   * Delete a value from the cache.
   * @param key - The key to delete.
   */
  async del(key: string): Promise<void> {
    await this.redis.del(key)
  }

  /**
   * Add a member to a set.
   * @param key - The key of the set.
   * @param members - The members to add to the set.
   */
  async sadd(key: string, ...members: string[]): Promise<void> {
    if (members.length === 0) return
    await this.redis.sadd(key, ...members)
  }

  /**
   * Check if a member is a member of a set.
   * @param key - The key of the set.
   * @param member - The member to check.
   * @returns True if the member is a member of the set, false otherwise.
   */
  async sismember(key: string, member: string): Promise<boolean> {
    const result = await this.redis.sismember(key, member)
    return result === 1
  }

  pipeline(): CachePipeline {
    return new RedisCachePipeline(this.redis.pipeline())
  }

  /**
   * Close the Redis connection.
   */
  async close(): Promise<void> {
    await this.redis.quit()
  }
}

class RedisCachePipeline implements CachePipeline {
  constructor(private pipeline: ChainableCommander) {}

  /**
   * Delete a value from the cache.
   * @param key - The key to delete.
   */
  del(key: string): this {
    this.pipeline.del(key)
    return this
  }

  /**
   * Add a member to a set.
   * @param key - The key of the set.
   * @param members - The members to add to the set.
   */
  sadd(key: string, ...members: string[]): this {
    if (members.length > 0) {
      this.pipeline.sadd(key, ...members)
    }
    return this
  }

  /**
   * Execute the pipeline.
   */
  async exec(): Promise<void> {
    await this.pipeline.exec()
  }
}
