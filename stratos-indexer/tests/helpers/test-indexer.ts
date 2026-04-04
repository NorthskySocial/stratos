import { Indexer } from '../../src/indexer.ts'
import type { IndexerConfig } from '../../src/config.ts'
import { loadConfig } from '../../src/config.ts'

export class TestIndexer {
  public indexer: Indexer
  private originalEnv: NodeJS.ProcessEnv

  constructor(public config: IndexerConfig) {
    this.indexer = new Indexer(config)
    this.originalEnv = { ...process.env }
  }

  static async create(overrides: Partial<NodeJS.ProcessEnv> = {}) {
    // Default test environment
    const testEnv = {
      BSKY_DB_POSTGRES_URL: 'postgres://localhost:5432/bsky_test',
      BSKY_DB_POSTGRES_SCHEMA: 'bsky_test',
      BSKY_DB_POOL_SIZE: '5',
      BSKY_REPO_PROVIDER: 'https://pds.example.com',
      STRATOS_SERVICE_URL: 'https://stratos.example.com',
      STRATOS_SYNC_TOKEN: 'test-token',
      HEALTH_PORT: '3003',
      WORKER_CONCURRENCY: '2',
      ...overrides,
    }

    const originalEnv = { ...process.env }
    Object.assign(process.env, testEnv)

    try {
      const config = loadConfig()
      return new TestIndexer(config)
    } finally {
      process.env = originalEnv
    }
  }

  async start() {
    await this.indexer.start()
  }

  async stop() {
    await this.indexer.stop()
  }
}
