import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getRecordHandler,
  getRepoHandler,
  listRecordsHandler,
} from '../src/api/handlers/index.js'
import { AppContext } from '../src'
import * as records from '../src/api/records/read.js'
import { StratosRepoRootNotFoundError } from '@northskysocial/stratos-core'

vi.mock('../src/api/records/read.js', () => ({
  getRecord: vi.fn(),
  listRecords: vi.fn(),
}))

vi.mock('@northskysocial/stratos-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@northskysocial/stratos-core')>()
  return {
    ...actual,
    exportRepoCarStream: vi.fn(),
  }
})

import { exportRepoCarStream } from '@northskysocial/stratos-core'

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

  describe('getRepoHandler', () => {
    let mockActorStore: any

    beforeEach(() => {
      mockActorStore = {
        exists: vi.fn().mockResolvedValue(true),
        read: vi.fn(async (_did: string, fn: (store: any) => Promise<any>) =>
          fn({ repo: { getRootDetailed: vi.fn(), iterateCarBlocks: vi.fn() } }),
        ),
      }
      mockCtx.actorStore = mockActorStore
      ;(exportRepoCarStream as any).mockImplementation(async function* () {
        yield new Uint8Array([1, 2, 3])
        yield new Uint8Array([4, 5])
      })
    })

    const invoke = (did: string, params: Record<string, unknown>) => {
      const handler = getRepoHandler(mockCtx as AppContext)
      return handler({
        params,
        input: undefined,
        auth: { credentials: { did } } as any,
        req: { auth: { credentials: { did } } } as any,
      })
    }

    it('exports a CAR for the repo owner', async () => {
      const result: any = await invoke('did:example:kusanagi', {
        did: 'did:example:kusanagi',
      })

      expect(mockActorStore.exists).toHaveBeenCalledWith('did:example:kusanagi')
      expect(result.encoding).toBe('application/vnd.ipld.car')
      expect(Buffer.from(result.body)).toEqual(Buffer.from([1, 2, 3, 4, 5]))
    })

    it('forwards the since cursor to the export stream', async () => {
      await invoke('did:example:kusanagi', {
        did: 'did:example:kusanagi',
        since: '3jzfcijpj2z2a',
      })

      expect(exportRepoCarStream).toHaveBeenCalledWith(
        expect.anything(),
        '3jzfcijpj2z2a',
      )
    })

    it('rejects when the caller is not the repo owner', async () => {
      const err: any = await invoke('did:example:batou', {
        did: 'did:example:kusanagi',
      }).catch((e) => e)

      expect(err.message).toBe('Only the repo owner may export the repository')
      expect(err.customErrorName).toBe('RepoNotFound')
      expect(mockActorStore.exists).not.toHaveBeenCalled()
      expect(exportRepoCarStream).not.toHaveBeenCalled()
    })

    it('throws RepoNotFound when the repo does not exist', async () => {
      mockActorStore.exists.mockResolvedValue(false)

      const err: any = await invoke('did:example:kusanagi', {
        did: 'did:example:kusanagi',
      }).catch((e) => e)

      expect(err.message).toBe('Could not find repo')
      expect(err.customErrorName).toBe('RepoNotFound')
      expect(exportRepoCarStream).not.toHaveBeenCalled()
    })

    it('throws RepoNotFound when the repo has no root commit', async () => {
      ;(exportRepoCarStream as any).mockImplementation(
        // eslint-disable-next-line require-yield
        async function* () {
          throw new StratosRepoRootNotFoundError()
        },
      )

      const err: any = await invoke('did:example:kusanagi', {
        did: 'did:example:kusanagi',
      }).catch((e) => e)

      expect(err.message).toBe('Could not find repo')
      expect(err.customErrorName).toBe('RepoNotFound')
    })

    it('rejects when the did param is missing', async () => {
      const err: any = await invoke('did:example:kusanagi', {
        did: '',
      }).catch((e) => e)

      expect(err.message).toBe('did is required')
      expect(exportRepoCarStream).not.toHaveBeenCalled()
    })

    it('propagates non-root errors without masking them as RepoNotFound', async () => {
      const boom = new Error('disk exploded')
      ;(exportRepoCarStream as any).mockImplementation(
        // eslint-disable-next-line require-yield
        async function* () {
          throw boom
        },
      )

      const err: any = await invoke('did:example:kusanagi', {
        did: 'did:example:kusanagi',
      }).catch((e) => e)

      expect(err).toBe(boom)
      expect(err.customErrorName).toBeUndefined()
    })
  })
})
