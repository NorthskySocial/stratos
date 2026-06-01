import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CID } from '@atproto/lex-data'
import { BlobAuthServiceImpl } from '../src/features'
import type { ActorStore } from '../src/actor-store-types.js'
import type { BoundaryResolver } from '@northskysocial/stratos-core'

describe('BlobAuthServiceImpl', () => {
  let mockActorStore: any
  let mockBoundaryResolver: any
  let service: BlobAuthServiceImpl
  const blobCid = CID.parse(
    'bafybeigdyrzt5scf7nqmbtcc3dbzbi7bc6mc4y7uxmrsgrmbglppvdb4ia',
  )

  beforeEach(() => {
    mockActorStore = {
      exists: vi.fn(),
      read: vi.fn(),
    }
    mockBoundaryResolver = {
      getBoundaries: vi.fn(),
    }
    service = new BlobAuthServiceImpl(
      mockActorStore as unknown as ActorStore,
      mockBoundaryResolver as unknown as BoundaryResolver,
    )
  })

  it('grants access if viewer is the owner', async () => {
    const result = await service.canAccessBlob(
      'did:plc:shinji',
      'did:plc:shinji',
      blobCid,
    )
    expect(result).toBe(true)
  })

  it('denies access if unauthenticated', async () => {
    const result = await service.canAccessBlob(null, 'did:plc:shinji', blobCid)
    expect(result).toBe(false)
  })

  it('denies access if actor repo does not exist', async () => {
    mockActorStore.exists.mockResolvedValue(false)
    mockBoundaryResolver.getBoundaries.mockResolvedValue([
      'did:web:nerv.tokyo.jp/pilots',
    ])

    const result = await service.canAccessBlob(
      'did:plc:asuka',
      'did:plc:shinji',
      blobCid,
    )
    expect(result).toBe(false)
  })

  it('grants access if viewer shares a boundary with a record referencing the blob', async () => {
    mockActorStore.exists.mockResolvedValue(true)
    mockBoundaryResolver.getBoundaries.mockResolvedValue([
      'did:web:nerv.tokyo.jp/pilots',
    ])

    const recordUri = 'at://did:plc:shinji/zone.stratos.feed.post/123'
    const mockRecord = {
      uri: recordUri,
      cid: 'cid-record',
      value: {
        text: 'Unit-01 ready.',
        boundary: {
          $type: 'zone.stratos.boundary.defs#Domains',
          values: [{ value: 'did:web:nerv.tokyo.jp/pilots' }],
        },
      },
    }

    mockActorStore.read.mockImplementation(
      async (did: string, fn: (store: any) => Promise<any>) => {
        const mockStore = {
          blob: {
            getRecordsForBlob: vi.fn().mockResolvedValue([recordUri]),
          },
          record: {
            getRecord: vi.fn().mockResolvedValue(mockRecord),
          },
        }
        return fn(mockStore)
      },
    )

    const result = await service.canAccessBlob(
      'did:plc:asuka',
      'did:plc:shinji',
      blobCid,
    )
    expect(result).toBe(true)
  })

  it('denies access if viewer does not share any boundary with referencing records', async () => {
    mockActorStore.exists.mockResolvedValue(true)
    mockBoundaryResolver.getBoundaries.mockResolvedValue([
      'did:web:nerv.tokyo.jp/others',
    ])

    const recordUri = 'at://did:plc:shinji/zone.stratos.feed.post/123'
    const mockRecord = {
      uri: recordUri,
      cid: 'cid-record',
      value: {
        text: 'Unit-01 ready.',
        boundary: {
          $type: 'zone.stratos.boundary.defs#Domains',
          values: [{ value: 'did:web:nerv.tokyo.jp/pilots' }],
        },
      },
    }

    mockActorStore.read.mockImplementation(
      async (did: string, fn: (store: any) => Promise<any>) => {
        const mockStore = {
          blob: {
            getRecordsForBlob: vi.fn().mockResolvedValue([recordUri]),
          },
          record: {
            getRecord: vi.fn().mockResolvedValue(mockRecord),
          },
        }
        return fn(mockStore)
      },
    )

    const result = await service.canAccessBlob(
      'did:plc:asuka',
      'did:plc:shinji',
      blobCid,
    )
    expect(result).toBe(false)
  })

  it('denies access to orphaned blobs', async () => {
    mockActorStore.exists.mockResolvedValue(true)
    mockBoundaryResolver.getBoundaries.mockResolvedValue([
      'did:web:nerv.tokyo.jp/pilots',
    ])

    mockActorStore.read.mockImplementation(
      async (did: string, fn: (store: any) => Promise<any>) => {
        const mockStore = {
          blob: {
            getRecordsForBlob: vi.fn().mockResolvedValue([]),
          },
        }
        return fn(mockStore)
      },
    )

    const result = await service.canAccessBlob(
      'did:plc:asuka',
      'did:plc:shinji',
      blobCid,
    )
    expect(result).toBe(false)
  })
})
