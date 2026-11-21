import { vi } from 'vitest'
import { randomBytes } from 'crypto'
import { CID, Cid } from '@atproto/lex-data'
import { sha256 } from 'multiformats/hashes/sha2'
import type {
  BlobContentStore,
  BlobStore,
  BlobStoreCreator,
} from '@northskysocial/stratos-core'
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'

let pgContainer: StartedPostgreSqlContainer | null = null

export async function startPostgresContainer(): Promise<string> {
  pgContainer = await new PostgreSqlContainer('postgres:18-alpine')
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

function createMockBlobStore(): BlobStore & BlobContentStore {
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
      // Create a proper ReadableStream for BlobContentStore compatibility
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })
    }) as any,
    getTempStream: vi.fn().mockImplementation(async (key: string) => {
      const bytes = storage.get(key)
      if (!bytes) return null
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })
    }) as any,
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
