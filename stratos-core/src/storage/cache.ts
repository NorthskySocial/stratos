/**
 * Caching interface for shared data
 */
export interface Cache {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string, ttlSeconds?: number) => Promise<void>
  del: (key: string) => Promise<void>
  sadd: (key: string, ...members: string[]) => Promise<void>
  sismember: (key: string, member: string) => Promise<boolean>
  pipeline: () => CachePipeline
  close: () => Promise<void>
}

/**
 * Interface for batching cache operations
 */
export interface CachePipeline {
  del: (key: string) => this
  sadd: (key: string, ...members: string[]) => this
  exec: () => Promise<void>
}
