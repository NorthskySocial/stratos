import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getBlobHandler, listBlobsHandler } from '../src/api/handlers/index.js'
import { AppContext } from '../src'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { parseCid } from '@northskysocial/stratos-core'
import { Readable } from 'node:stream'

describe('blob-handlers', () => {
  let mockCtx: any
  let mockActorStore: any
  let mockBlobAuth: any

  beforeEach(() => {
    mockBlobAuth = {
      canAccessBlob: vi.fn(),
    }
    mockActorStore = {
      exists: vi.fn(),
      read: vi.fn(),
    }
    mockCtx = {
      blobAuth: mockBlobAuth,
      actorStore: mockActorStore,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }
  })

  describe('getBlobHandler', () => {
    it('throws error if DID is missing', async () => {
      const handler = getBlobHandler(mockCtx as AppContext)
      await expect(
        handler({
          params: {
            cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
          },
          input: undefined,
          req: {} as any,
        }),
      ).rejects.toThrow(new InvalidRequestError('did is required'))
    })

    it('throws error if CID is missing', async () => {
      const handler = getBlobHandler(mockCtx as AppContext)
      await expect(
        handler({
          params: { did: 'did:example:alice' },
          input: undefined,
          req: {} as any,
        }),
      ).rejects.toThrow(new InvalidRequestError('cid is required'))
    })

    it('throws error if access is denied', async () => {
      const did = 'did:example:alice'
      const cidStr =
        'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
      mockBlobAuth.canAccessBlob.mockResolvedValue(false)

      const handler = getBlobHandler(mockCtx as AppContext)
      await expect(
        handler({
          params: { did, cid: cidStr },
          input: undefined,
          req: {} as any,
        }),
      ).rejects.toThrow(
        new InvalidRequestError(
          'Access denied to blob due to boundary restrictions',
          'BlobBlocked',
        ),
      )
      expect(mockBlobAuth.canAccessBlob).toHaveBeenCalledWith(
        null,
        did,
        parseCid(cidStr),
      )
    })

    it('throws RepoNotFound if actor store does not exist', async () => {
      const did = 'did:example:alice'
      const cidStr =
        'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
      mockBlobAuth.canAccessBlob.mockResolvedValue(true)
      mockActorStore.exists.mockResolvedValue(false)

      const handler = getBlobHandler(mockCtx as AppContext)
      await expect(
        handler({
          params: { did, cid: cidStr },
          input: undefined,
          req: {} as any,
        }),
      ).rejects.toThrow(
        new InvalidRequestError('Could not find repo', 'RepoNotFound'),
      )
    })

    it('returns blob stream and encoding on success', async () => {
      const did = 'did:example:alice'
      const cidStr =
        'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
      const mockStream = Readable.from([Buffer.from('hello world')])

      mockBlobAuth.canAccessBlob.mockResolvedValue(true)
      mockActorStore.exists.mockResolvedValue(true)
      mockActorStore.read.mockImplementation(async (did: string, fn: any) => {
        return fn({
          blob: {
            getBlob: vi.fn().mockResolvedValue({
              mimeType: 'image/png',
              size: 11,
              stream: mockStream,
            }),
          },
        })
      })

      const handler = getBlobHandler(mockCtx as AppContext)
      const result = await handler({
        params: { did, cid: cidStr },
        input: undefined,
        req: {} as any,
      })

      expect(result).toEqual({
        encoding: 'image/png',
        body: mockStream,
      })
    })

    it('throws BlobNotFound if blob does not exist', async () => {
      const did = 'did:example:alice'
      const cidStr =
        'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

      mockBlobAuth.canAccessBlob.mockResolvedValue(true)
      mockActorStore.exists.mockResolvedValue(true)
      mockActorStore.read.mockImplementation(async (did: string, fn: any) => {
        return fn({
          blob: {
            getBlob: vi.fn().mockResolvedValue(null),
          },
        })
      })

      const handler = getBlobHandler(mockCtx as AppContext)
      await expect(
        handler({
          params: { did, cid: cidStr },
          input: undefined,
          req: {} as any,
        }),
      ).rejects.toThrow(
        new InvalidRequestError('Blob not found', 'BlobNotFound'),
      )
    })
  })

  describe('listBlobsHandler', () => {
    it('throws error if DID is missing', async () => {
      const handler = listBlobsHandler(mockCtx as AppContext)
      await expect(
        handler({
          params: {},
          input: undefined,
          req: {} as any,
        }),
      ).rejects.toThrow(new InvalidRequestError('did is required'))
    })

    it('throws RepoNotFound if actor store does not exist', async () => {
      const did = 'did:example:alice'
      mockActorStore.exists.mockResolvedValue(false)

      const handler = listBlobsHandler(mockCtx as AppContext)
      await expect(
        handler({
          params: { did },
          input: undefined,
          req: {} as any,
        }),
      ).rejects.toThrow(
        new InvalidRequestError('Could not find repo', 'RepoNotFound'),
      )
    })

    it('returns list of CIDs and cursor on success', async () => {
      const did = 'did:example:alice'
      const cids = ['cid1', 'cid2']

      mockActorStore.exists.mockResolvedValue(true)
      mockActorStore.read.mockImplementation(async (did: string, fn: any) => {
        return fn({
          blob: {
            listBlobs: vi.fn().mockResolvedValue(cids),
          },
        })
      })

      const handler = listBlobsHandler(mockCtx as AppContext)
      const result = await handler({
        params: { did, limit: 2 },
        input: undefined,
        req: {} as any,
      })

      expect(result.body).toEqual({
        cids,
        cursor: 'cid2',
      })
    })

    it('returns undefined cursor if less than limit', async () => {
      const did = 'did:example:alice'
      const cids = ['cid1']

      mockActorStore.exists.mockResolvedValue(true)
      mockActorStore.read.mockImplementation(async (did: string, fn: any) => {
        return fn({
          blob: {
            listBlobs: vi.fn().mockResolvedValue(cids),
          },
        })
      })

      const handler = listBlobsHandler(mockCtx as AppContext)
      const result = await handler({
        params: { did, limit: 2 },
        input: undefined,
        req: {} as any,
      })

      expect(result.body).toEqual({
        cids,
        cursor: undefined,
      })
    })
  })
})
