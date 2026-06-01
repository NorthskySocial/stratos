import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HydrationServiceImpl,
  registerHydrationHandlers,
} from '../src/features'
import { AppContext } from '../src'

vi.mock('../src/features/hydration/adapter.js', () => ({
  ActorStoreRecordResolver: vi.fn().mockImplementation(function () {
    return {}
  }),
  HydrationServiceImpl: vi.fn().mockImplementation(function () {
    return {
      hydrateRecords: vi.fn(),
      hydrateRecord: vi.fn(),
    }
  }),
}))

describe('hydration-handler', () => {
  let mockCtx: any
  let mockServer: any
  let handlers: Record<string, any> = {}

  beforeEach(() => {
    vi.clearAllMocks()
    handlers = {}
    mockServer = {
      method: vi.fn().mockImplementation((name, options) => {
        handlers[name] = options.handler
      }),
    }
    mockCtx = {
      actorStore: {},
      boundaryResolver: {
        getBoundaries: vi.fn().mockResolvedValue(['engineering']),
      },
      hydrationService: {
        hydrateRecords: vi.fn(),
        hydrateRecord: vi.fn(),
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }
    registerHydrationHandlers(mockServer, mockCtx as AppContext)
  })

  describe('zone.stratos.repo.hydrateRecords', () => {
    it('returns empty results for empty URIs array', async () => {
      const handler = handlers['zone.stratos.repo.hydrateRecords']
      const result = await handler({
        input: { body: { uris: [] } },
        params: {} as any,
        req: {} as any,
        res: {} as any,
      })

      expect(result.body).toEqual({
        records: [],
        notFound: [],
        blocked: [],
      })
    })

    it('throws error if URIs array is missing', async () => {
      const handler = handlers['zone.stratos.repo.hydrateRecords']
      await expect(
        handler({
          input: { body: {} },
          params: {} as any,
          req: {} as any,
          res: {} as any,
        }),
      ).rejects.toThrow('URIs array required')
    })

    it('throws error if too many URIs', async () => {
      const handler = handlers['zone.stratos.repo.hydrateRecords']
      const uris = Array(101).fill('at://did:example:alice/coll/123')
      await expect(
        handler({
          input: { body: { uris } },
          params: {} as any,
          req: {} as any,
          res: {} as any,
        }),
      ).rejects.toThrow('Maximum of 100 URIs per request')
    })

    it('calls hydrationService and returns results', async () => {
      const uris = ['at://did:example:alice/coll/123']
      const mockResult = {
        records: [{ uri: uris[0], cid: 'cid1', value: { text: 'hello' } }],
        notFound: [],
        blocked: [],
      }

      mockCtx.hydrationService.hydrateRecords.mockResolvedValue(mockResult)
      const handler = handlers['zone.stratos.repo.hydrateRecords']

      const result = await handler({
        input: { body: { uris } },
        params: {} as any,
        auth: { credentials: { did: 'did:example:bob' } } as any,
        req: {} as any,
        res: {} as any,
      })

      expect(mockCtx.boundaryResolver.getBoundaries).toHaveBeenCalledWith(
        'did:example:bob',
      )
      expect(mockCtx.hydrationService.hydrateRecords).toHaveBeenCalledWith(
        [{ uri: uris[0] }],
        expect.objectContaining({
          viewerDid: 'did:example:bob',
          viewerDomains: ['engineering'],
        }),
      )
      expect(result.body).toEqual(mockResult)
    })
  })

  describe('zone.stratos.repo.hydrateRecord', () => {
    it('throws error if URI is missing', async () => {
      const handler = handlers['zone.stratos.repo.hydrateRecord']
      await expect(
        handler({
          params: {},
          input: null,
          req: {} as any,
          res: {} as any,
        }),
      ).rejects.toThrow('URI required')
    })

    it('returns record on success', async () => {
      const uri = 'at://did:example:alice/coll/123'
      const mockRecord = { uri, cid: 'cid1', value: { text: 'hello' } }

      mockCtx.hydrationService.hydrateRecord.mockResolvedValue({
        status: 'success',
        record: mockRecord,
      })
      const handler = handlers['zone.stratos.repo.hydrateRecord']

      const result = await handler({
        params: { uri },
        input: null,
        did: 'did:example:bob',
        req: {} as any,
        res: {} as any,
      })

      expect(result.body).toEqual(mockRecord)
    })

    it('throws RecordNotFound when status is not-found', async () => {
      const uri = 'at://did:example:alice/coll/123'

      mockCtx.hydrationService.hydrateRecord.mockResolvedValue({
        status: 'not-found',
      })
      const handler = handlers['zone.stratos.repo.hydrateRecord']

      await expect(
        handler({
          params: { uri },
          input: null,
          req: {} as any,
          res: {} as any,
        }),
      ).rejects.toThrow('Record not found')
    })

    it('throws RecordBlocked when status is blocked', async () => {
      const uri = 'at://did:example:alice/coll/123'

      mockCtx.hydrationService.hydrateRecord.mockResolvedValue({
        status: 'blocked',
      })
      const handler = handlers['zone.stratos.repo.hydrateRecord']

      await expect(
        handler({
          params: { uri },
          input: null,
          req: {} as any,
          res: {} as any,
        }),
      ).rejects.toThrow('Record blocked due to boundary restrictions')
    })
  })
})
