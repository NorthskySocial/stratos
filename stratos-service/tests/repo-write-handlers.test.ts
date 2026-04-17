import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyWritesHandler,
  createRecordHandler,
  deleteRecordHandler,
  stratosUploadBlobHandler,
  uploadBlobHandler,
} from '../src/api/handlers/index.js'
import { AppContext } from '../src'
import * as records from '../src/api/records/index.js'
import { Readable } from 'node:stream'

vi.mock('../src/api/records/index.js', () => ({
  createRecord: vi.fn(),
  deleteRecord: vi.fn(),
  applyWritesBatch: vi.fn(),
}))

describe('repo-write-handlers', () => {
  let mockCtx: any
  let mockActorStore: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockActorStore = {
      write: vi.fn(),
      exists: vi.fn().mockResolvedValue(true),
      create: vi.fn().mockResolvedValue(undefined),
    }
    mockCtx = {
      actorStore: mockActorStore,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }
  })

  describe('createRecordHandler', () => {
    it('calls createRecord and returns result without phases', async () => {
      const handler = createRecordHandler(mockCtx as AppContext)
      const input = {
        repo: 'did:example:alice',
        collection: 'app.bsky.feed.post',
        record: { text: 'hello' },
      }
      const mockResult = {
        uri: 'at://did:example:alice/app.bsky.feed.post/123',
        cid: 'cid1',
        phases: { prepareCommitBuild: 10 },
      }

      vi.mocked(records.createRecord).mockResolvedValue(mockResult as any)

      const result = await handler({
        input: { body: input },
        params: {} as any,
        auth: { credentials: { did: 'did:example:alice' } } as any,
        req: {} as any,
      })

      expect(records.createRecord).toHaveBeenCalledWith(
        mockCtx,
        expect.objectContaining({
          repo: input.repo,
          collection: input.collection,
          record: input.record,
        }),
        'did:example:alice',
      )
      expect(result.body).toEqual({
        uri: mockResult.uri,
        cid: mockResult.cid,
      })
    })
  })

  describe('deleteRecordHandler', () => {
    it('calls deleteRecord and returns result without phases', async () => {
      const handler = deleteRecordHandler(mockCtx as AppContext)
      const input = {
        repo: 'did:example:alice',
        collection: 'app.bsky.feed.post',
        rkey: '123',
      }
      const mockResult = { commit: { cid: 'cid2' }, phases: { somePhase: 5 } }

      vi.mocked(records.deleteRecord).mockResolvedValue(mockResult as any)

      const result = await handler({
        input: { body: input },
        params: {} as any,
        auth: { credentials: { did: 'did:example:alice' } } as any,
        req: {} as any,
      })

      expect(records.deleteRecord).toHaveBeenCalledWith(
        mockCtx,
        expect.objectContaining({
          repo: input.repo,
          rkey: input.rkey,
        }),
        'did:example:alice',
      )
      expect(result.body).toEqual({
        commit: mockResult.commit,
      })
    })
  })

  describe('uploadBlobHandler', () => {
    it('uploads a blob from stream', async () => {
      const handler = uploadBlobHandler(mockCtx as AppContext)
      const mockStream = Readable.from([Buffer.from('blob data')])
      const mockBlobStore = {
        putTemp: vi.fn().mockResolvedValue('temp-key'),
      }
      mockActorStore.getBlobStore = vi.fn().mockReturnValue(mockBlobStore)
      mockActorStore.exists = vi.fn().mockResolvedValue(true)
      mockActorStore.transact = vi.fn().mockImplementation(async (did, fn) => {
        return fn({
          blob: {
            trackBlob: vi.fn().mockResolvedValue(undefined),
          },
        })
      })

      const result = await handler({
        input: { body: mockStream, encoding: 'text/plain' },
        params: {} as any,
        auth: { credentials: { did: 'did:example:alice' } } as any,
        req: {} as any,
      })

      expect(mockActorStore.getBlobStore).toHaveBeenCalledWith(
        'did:example:alice',
      )
      expect(mockBlobStore.putTemp).toHaveBeenCalled()
      expect(mockActorStore.transact).toHaveBeenCalled()
      expect(result.body).toEqual({
        blob: {
          $type: 'blob',
          ref: { $link: expect.any(String) },
          mimeType: 'text/plain',
          size: 9,
        },
      })
    })
  })

  describe('stratosUploadBlobHandler', () => {
    it('delegates to uploadBlobHandler logic', async () => {
      const handler = stratosUploadBlobHandler(mockCtx as AppContext)
      const mockStream = Readable.from([Buffer.from('stratos blob')])
      const mockBlobStore = {
        putTemp: vi.fn().mockResolvedValue('temp-key'),
      }
      mockActorStore.getBlobStore = vi.fn().mockReturnValue(mockBlobStore)
      mockActorStore.exists = vi.fn().mockResolvedValue(true)
      mockActorStore.transact = vi.fn().mockImplementation(async (did, fn) => {
        const store = {
          blob: {
            trackBlob: vi.fn().mockResolvedValue(undefined),
          },
        }
        return fn(store)
      })

      const result = await handler({
        input: { body: mockStream, encoding: 'image/png' },
        params: {} as any,
        auth: { credentials: { did: 'did:example:alice' } } as any,
        req: {} as any,
      })

      expect(result.body).toEqual({
        blob: {
          $type: 'blob',
          ref: { $link: expect.any(String) },
          mimeType: 'image/png',
          size: 12,
        },
      })
    })
  })

  describe('applyWritesHandler', () => {
    it('calls applyWritesBatch', async () => {
      const handler = applyWritesHandler(mockCtx as AppContext)
      const input = { repo: 'did:example:alice', writes: [] }
      const mockResult = { commit: { cid: 'cid3' }, phases: {} }

      vi.mocked(records.applyWritesBatch).mockResolvedValue(mockResult as any)

      const result = await handler({
        input: { body: input },
        params: {} as any,
        auth: { credentials: { did: 'did:example:alice' } } as any,
        req: {} as any,
      })

      expect(records.applyWritesBatch).toHaveBeenCalledWith(
        mockCtx,
        'did:example:alice',
        input.writes,
        expect.any(String),
      )
      expect(result.body).toEqual({
        commit: mockResult.commit,
      })
    })
  })
})
