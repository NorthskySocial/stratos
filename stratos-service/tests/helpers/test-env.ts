import { vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { CID, Cid } from '@atproto/lex-data'
import { sha256 } from 'multiformats/hashes/sha2'
import type {
  BlobContentStore,
  BlobStore,
  BlobStoreCreator,
} from '@northskysocial/stratos-core'
import { StratosActorStore } from '../../src/context.js'
import { PostgresStorageFactory as PostgresActorStore } from '../../src/infra/storage/postgres/factory.js'
import type { ActorStore } from '../../src/actor-store-types.js'
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'

export const POSTGRES_URL = process.env.STRATOS_POSTGRES_URL
export const IS_POSTGRES =
  process.env.STRATOS_TEST_BACKEND === 'postgres' || !!POSTGRES_URL
export const HAS_POSTGRES = !!POSTGRES_URL

let pgContainer: StartedPostgreSqlContainer | null = null

export async function startPostgresContainer(): Promise<string> {
  pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('stratos_test')
    .withUsername('stratos')
    .withPassword('stratos')
    .start()
  return pgContainer.getConnectionUri()
}

export async function stopPostgresContainer(): Promise<void> {
  if (pgContainer) {
    await pgContainer.stop()
    pgContainer = null
  }
}

export function cborToRecord(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes))
}

export async function createCid(data: string | Uint8Array): Promise<Cid> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const hash = await sha256.digest(bytes)
  return CID.createV1(0x55, hash)
}

export function createMockBlobStore(): BlobStore & BlobContentStore {
  const storage = new Map<string, Uint8Array>()
  return {
    putTemp: vi.fn().mockImplementation(async (bytes: Uint8Array) => {
      const key = `temp-${randomBytes(8).toString('hex')}`
      storage.set(key, bytes)
      return key
    }),
    makePermanent: vi.fn().mockImplementation(async (key: string, cid: Cid) => {
      const bytes = storage.get(key)
      if (bytes) {
        storage.set(cid.toString(), bytes)
        storage.delete(key)
      }
    }),
    putPermanent: vi
      .fn()
      .mockImplementation(
        async (cid: Cid, bytes: Uint8Array | AsyncIterable<Uint8Array>) => {
          if (!(Symbol.asyncIterator in bytes)) {
            storage.set(cid.toString(), bytes as Uint8Array)
          } else {
            const chunks: Uint8Array[] = []
            for await (const chunk of bytes as AsyncIterable<Uint8Array>) {
              chunks.push(chunk)
            }
            const total = new Uint8Array(
              chunks.reduce((sum, c) => sum + c.length, 0),
            )
            let offset = 0
            for (const chunk of chunks) {
              total.set(chunk, offset)
              offset += chunk.length
            }
            storage.set(cid.toString(), total)
          }
        },
      ),
    quarantine: vi.fn().mockResolvedValue(undefined),
    unquarantine: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockImplementation(async (cid: Cid) => {
      storage.delete(cid.toString())
    }),
    deleteMany: vi.fn().mockImplementation(async (cids: Cid[]) => {
      for (const cid of cids) {
        storage.delete(cid.toString())
      }
    }),
    deleteContent: vi.fn().mockImplementation(async (cid: Cid) => {
      storage.delete(cid.toString())
    }),
    hasTemp: vi
      .fn()
      .mockImplementation(async (key: string) => storage.has(key)),
    hasStored: vi
      .fn()
      .mockImplementation(async (cid: Cid) => storage.has(cid.toString())),
    getBytes: vi.fn().mockImplementation(async (cid: Cid) => {
      const bytes = storage.get(cid.toString())
      if (!bytes) return null
      return bytes
    }),
    getStream: vi.fn().mockImplementation(async (cid: Cid) => {
      const bytes = storage.get(cid.toString())
      if (!bytes) return null
      async function* generate() {
        yield bytes!
      }
      // @ts-ignore - simplified stream for mock
      return generate()
    }),
  }
}

export function createMockBlobStoreCreator(): BlobStoreCreator {
  const stores = new Map<string, BlobStore>()
  return (did: string) => {
    if (!stores.has(did)) {
      stores.set(did, createMockBlobStore())
    }
    return stores.get(did)!
  }
}

export interface TestBackend {
  actorStore: ActorStore
  cleanup: () => Promise<void>
}

export async function createTestBackend(): Promise<TestBackend> {
  if (IS_POSTGRES && POSTGRES_URL) {
    return createPostgresBackend(POSTGRES_URL)
  }
  return createSqliteBackend()
}

async function createSqliteBackend(): Promise<TestBackend> {
  const testDir = join(
    tmpdir(),
    `stratos-test-${randomBytes(8).toString('hex')}`,
  )
  await mkdir(testDir, { recursive: true })

  const blobstore = createMockBlobStoreCreator()
  const actorStore = new StratosActorStore({
    dataDir: join(testDir, 'actors'),
    blobstore,
    cborToRecord,
  })

  return {
    actorStore,
    cleanup: async () => {
      await rm(testDir, { recursive: true, force: true })
    },
  }
}

async function createPostgresBackend(
  postgresUrl: string,
): Promise<TestBackend> {
  const blobstore = createMockBlobStoreCreator() as unknown as (
    did: string,
  ) => BlobContentStore
  const actorStore = new PostgresActorStore({
    connectionString: postgresUrl,
    serviceDb: {} as any,
    blobContentStoreCreator: blobstore,
    cborToRecord,
  }) as unknown as ActorStore

  return {
    actorStore,
    cleanup: async () => {
      // PG schemas are cleaned up per-actor in tests via actorStore.destroy()
    },
  }
}
