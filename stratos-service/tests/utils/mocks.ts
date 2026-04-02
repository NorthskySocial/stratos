import { vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Cid } from '@atproto/lex-data'
import { BlobStore } from '@northskysocial/stratos-core'

/**
 * Mock blob store for testing
 */
export function createMockBlobStore(): BlobStore {
  const storage = new Map<string, Uint8Array>()
  const tempStorage = new Map<string, Uint8Array>()

  return {
    putTemp: vi.fn().mockImplementation(async (bytes: Uint8Array) => {
      const key = `temp-${randomBytes(8).toString('hex')}`
      if (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) {
        tempStorage.set(key, bytes)
      }
      return key
    }),
    makePermanent: vi.fn().mockImplementation(async (key: string, cid: Cid) => {
      const bytes = tempStorage.get(key)
      if (bytes) {
        storage.set(cid.toString(), bytes)
        tempStorage.delete(key)
      }
    }),
    putPermanent: vi
      .fn()
      .mockImplementation(async (cid: Cid, bytes: Uint8Array) => {
        if (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) {
          storage.set(cid.toString(), bytes)
        }
      }),
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
    hasTemp: vi.fn().mockImplementation(async (key: string) => {
      return tempStorage.has(key)
    }),
    hasStored: vi.fn().mockImplementation(async (cid: Cid) => {
      return storage.has(cid.toString())
    }),
    getBytes: vi.fn().mockImplementation(async (cid: Cid) => {
      const bytes = storage.get(cid.toString())
      if (!bytes) throw new Error('Blob not found')
      return bytes
    }),
    getStream: vi.fn().mockImplementation(async (cid: Cid) => {
      const bytes = storage.get(cid.toString())
      if (!bytes) throw new Error('Blob not found')
      async function* generate() {
        yield bytes!
      }
      return generate()
    }),
  }
}
