import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { StratosServer } from '../../src/index.js'
import { envToConfig, parseEnv } from '../../src/config.js'
import { createMockBlobStoreCreator, cborToRecord } from './test-env.js'
import { createLogger } from '../../src/logger.js'

export class TestServer {
  constructor(
    public server: StratosServer,
    public dataDir: string,
  ) {}

  static async create() {
    const dataDir = join(
      tmpdir(),
      `stratos-test-server-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })

    // Minimal environment for testing
    const env = {
      STRATOS_SERVICE_DID: 'did:web:test.stratos.actor',
      STRATOS_PORT: '3101', // Explicit positive port for tests
      STRATOS_PUBLIC_URL: 'https://example.com', // Compliant URL for OAuth client
      STRATOS_DATA_DIR: dataDir,
      STRATOS_ALLOWED_DOMAINS: 'test.com,example.com',
      STRATOS_ENROLLMENT_MODE: 'open',
      STRATOS_SIGNING_KEY_HEX: randomBytes(32).toString('hex'),
      STORAGE_BACKEND: 'sqlite',
      STRATOS_DEV_MODE: 'true', // Allow dev mode for testing
    }

    // Backup and set process.env
    const originalEnv = { ...process.env }
    Object.assign(process.env, env)

    try {
      const cfg = envToConfig(parseEnv())
      const blobstore = createMockBlobStoreCreator()
      const logger = createLogger('error') // Quiet logs for tests

      const server = await StratosServer.create(
        cfg,
        blobstore,
        cborToRecord,
        logger,
      )

      return new TestServer(server, dataDir)
    } finally {
      // Restore environment
      process.env = originalEnv
    }
  }

  async start() {
    await this.server.start()
  }

  async stop() {
    await this.server.stop()
    await rm(this.dataDir, { recursive: true, force: true })
  }

  get url() {
    if (!this.server.server) throw new Error('Server not started')
    const address = this.server.server.address()
    if (typeof address === 'string') return address
    return `http://localhost:${address?.port}`
  }
}
