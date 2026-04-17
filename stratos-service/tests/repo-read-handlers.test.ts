import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getRecordHandler,
  listRecordsHandler,
} from '../src/api/handlers/index.js'
import { AppContext } from '../src'
import * as records from '../src/api/records/read.js'

vi.mock('../src/api/records/read.js', () => ({
  getRecord: vi.fn(),
  listRecords: vi.fn(),
}))

describe('repo-read-handlers', () => {
  let mockCtx: any
  let mockBoundaryResolver: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockBoundaryResolver = {
      getBoundaries: vi.fn().mockResolvedValue(['engineering']),
    }
    mockCtx = {
      boundaryResolver: mockBoundaryResolver,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }
  })

  describe('getRecordHandler', () => {
    it('calls getRecord without auth', async () => {
      const handler = getRecordHandler(mockCtx as AppContext)
      const params = {
        repo: 'did:example:alice',
        collection: 'app.bsky.feed.post',
        rkey: '123',
      }

      await handler({
        params,
        input: undefined,
        auth: undefined,
        req: {} as any,
      })

      expect(records.getRecord).toHaveBeenCalledWith(
        mockCtx,
        {
          repo: params.repo,
          collection: params.collection,
          rkey: params.rkey,
          cid: undefined,
        },
        undefined,
        [],
      )
    })

    it('calls getRecord with auth', async () => {
      const handler = getRecordHandler(mockCtx as AppContext)
      const params = {
        repo: 'did:example:alice',
        collection: 'app.bsky.feed.post',
        rkey: '123',
      }
      const auth = { credentials: { did: 'did:example:bob' } }

      await handler({
        params,
        input: undefined,
        auth: auth as any,
        req: {} as any,
      })

      expect(mockBoundaryResolver.getBoundaries).toHaveBeenCalledWith(
        'did:example:bob',
      )
      expect(records.getRecord).toHaveBeenCalledWith(
        mockCtx,
        {
          repo: params.repo,
          collection: params.collection,
          rkey: params.rkey,
          cid: undefined,
        },
        'did:example:bob',
        ['engineering'],
      )
    })
  })

  describe('listRecordsHandler', () => {
    it('calls listRecords without auth', async () => {
      const handler = listRecordsHandler(mockCtx as AppContext)
      const params = {
        repo: 'did:example:alice',
        collection: 'app.bsky.feed.post',
        limit: 10,
      }

      await handler({
        params,
        input: undefined,
        auth: undefined,
        req: {} as any,
      })

      expect(records.listRecords).toHaveBeenCalledWith(
        mockCtx,
        {
          repo: params.repo,
          collection: params.collection,
          limit: 10,
          cursor: undefined,
          reverse: undefined,
        },
        undefined,
        [],
      )
    })

    it('calls listRecords with auth', async () => {
      const handler = listRecordsHandler(mockCtx as AppContext)
      const params = {
        repo: 'did:example:alice',
        collection: 'app.bsky.feed.post',
      }
      const auth = { credentials: { did: 'did:example:bob' } }

      await handler({
        params,
        input: undefined,
        auth: auth as any,
        req: {} as any,
      })

      expect(mockBoundaryResolver.getBoundaries).toHaveBeenCalledWith(
        'did:example:bob',
      )
      expect(records.listRecords).toHaveBeenCalledWith(
        mockCtx,
        {
          repo: params.repo,
          collection: params.collection,
          limit: undefined,
          cursor: undefined,
          reverse: undefined,
        },
        'did:example:bob',
        ['engineering'],
      )
    })
  })
})
