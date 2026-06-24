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

  it('denies access if getRecordsForBlob returns null', async () => {
    mockActorStore.exists.mockResolvedValue(true)
    mockBoundaryResolver.getBoundaries.mockResolvedValue([
      'did:web:nerv.tokyo.jp/pilots',
    ])

    const getRecord = vi.fn()
    mockActorStore.read.mockImplementation(
      async (did: string, fn: (store: any) => Promise<any>) => {
        const mockStore = {
          blob: {
            getRecordsForBlob: vi.fn().mockResolvedValue(null),
          },
          record: { getRecord },
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
    expect(getRecord).not.toHaveBeenCalled()
  })

  it('skips null records when checking access', async () => {
    mockActorStore.exists.mockResolvedValue(true)
    mockBoundaryResolver.getBoundaries.mockResolvedValue([
      'did:web:nerv.tokyo.jp/pilots',
    ])

    const missingUri = 'at://did:plc:shinji/zone.stratos.feed.post/missing'
    const presentUri = 'at://did:plc:shinji/zone.stratos.feed.post/present'
    const presentRecord = {
      uri: presentUri,
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
            getRecordsForBlob: vi
              .fn()
              .mockResolvedValue([missingUri, presentUri]),
          },
          record: {
            getRecord: vi
              .fn()
              .mockImplementation(async (uri: string) =>
                uri === presentUri ? presentRecord : null,
              ),
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

  describe('canAccessBlobs', () => {
    const cidA = CID.parse(
      'bafybeigdyrzt5scf7nqmbtcc3dbzbi7bc6mc4y7uxmrsgrmbglppvdb4ia',
    )
    const cidB = CID.parse(
      'bafybeibgg7zybeqceqqynygwf65rjmm7gkqgkpquvvbsmpxlsdz3jvkzry',
    )

    it('grants all when viewer is owner without consulting stores', async () => {
      const result = await service.canAccessBlobs(
        'did:plc:shinji',
        'did:plc:shinji',
        [cidA, cidB],
      )
      expect(result.get(cidA.toString())).toBe(true)
      expect(result.get(cidB.toString())).toBe(true)
      expect(mockBoundaryResolver.getBoundaries).not.toHaveBeenCalled()
      expect(mockActorStore.exists).not.toHaveBeenCalled()
    })

    it('denies all for unauthenticated viewer without consulting stores', async () => {
      const result = await service.canAccessBlobs(null, 'did:plc:shinji', [
        cidA,
        cidB,
      ])
      expect(result.get(cidA.toString())).toBe(false)
      expect(result.get(cidB.toString())).toBe(false)
      expect(mockBoundaryResolver.getBoundaries).not.toHaveBeenCalled()
      expect(mockActorStore.exists).not.toHaveBeenCalled()
    })

    it('resolves viewer boundaries exactly once for the batch', async () => {
      mockActorStore.exists.mockResolvedValue(true)
      mockBoundaryResolver.getBoundaries.mockResolvedValue([
        'did:web:nerv.tokyo.jp/pilots',
      ])
      mockActorStore.read.mockImplementation(
        async (did: string, fn: (store: any) => Promise<any>) => {
          const mockStore = {
            blob: { getRecordsForBlob: vi.fn().mockResolvedValue([]) },
            record: { getRecord: vi.fn() },
          }
          return fn(mockStore)
        },
      )

      await service.canAccessBlobs('did:plc:asuka', 'did:plc:shinji', [
        cidA,
        cidB,
      ])
      expect(mockBoundaryResolver.getBoundaries).toHaveBeenCalledTimes(1)
      expect(mockBoundaryResolver.getBoundaries).toHaveBeenCalledWith(
        'did:plc:asuka',
      )
    })

    it('returns mixed results per blob based on access', async () => {
      mockActorStore.exists.mockResolvedValue(true)
      mockBoundaryResolver.getBoundaries.mockResolvedValue([
        'did:web:nerv.tokyo.jp/pilots',
      ])

      const uriAccessible = 'at://did:plc:shinji/zone.stratos.feed.post/ok'
      const uriBlocked = 'at://did:plc:shinji/zone.stratos.feed.post/blocked'
      const accessibleRecord = {
        uri: uriAccessible,
        cid: 'cid-ok',
        value: {
          text: 'ok',
          boundary: {
            $type: 'zone.stratos.boundary.defs#Domains',
            values: [{ value: 'did:web:nerv.tokyo.jp/pilots' }],
          },
        },
      }
      const blockedRecord = {
        uri: uriBlocked,
        cid: 'cid-blocked',
        value: {
          text: 'blocked',
          boundary: {
            $type: 'zone.stratos.boundary.defs#Domains',
            values: [{ value: 'did:web:nerv.tokyo.jp/others' }],
          },
        },
      }

      mockActorStore.read.mockImplementation(
        async (did: string, fn: (store: any) => Promise<any>) => {
          const mockStore = {
            blob: {
              getRecordsForBlob: vi
                .fn()
                .mockImplementation(async (cid: any) =>
                  cid.toString() === cidA.toString()
                    ? [uriAccessible]
                    : [uriBlocked],
                ),
            },
            record: {
              getRecord: vi
                .fn()
                .mockImplementation(async (uri: string) =>
                  uri === uriAccessible ? accessibleRecord : blockedRecord,
                ),
            },
          }
          return fn(mockStore)
        },
      )

      const result = await service.canAccessBlobs(
        'did:plc:asuka',
        'did:plc:shinji',
        [cidA, cidB],
      )
      expect(result.get(cidA.toString())).toBe(true)
      expect(result.get(cidB.toString())).toBe(false)
    })

    it('denies blobs whose actor repo does not exist', async () => {
      mockActorStore.exists.mockResolvedValue(false)
      mockBoundaryResolver.getBoundaries.mockResolvedValue([
        'did:web:nerv.tokyo.jp/pilots',
      ])

      const result = await service.canAccessBlobs(
        'did:plc:asuka',
        'did:plc:shinji',
        [cidA],
      )
      expect(result.get(cidA.toString())).toBe(false)
      expect(mockActorStore.read).not.toHaveBeenCalled()
    })

    it('returns empty map when given no blobs', async () => {
      const result = await service.canAccessBlobs(
        'did:plc:asuka',
        'did:plc:shinji',
        [],
      )
      expect(result.size).toBe(0)
    })
  })
})
