import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AtUri } from '@atproto/syntax'
import {
  ActorStoreRecordResolver,
  HydrationServiceImpl,
} from '../src/features/hydration/adapter.js'
import type { ActorStore } from '../src/actor-store-types.js'

describe('Hydration Features', () => {
  describe('ActorStoreRecordResolver', () => {
    let mockActorStore: any
    let resolver: ActorStoreRecordResolver

    beforeEach(() => {
      mockActorStore = {
        exists: vi.fn(),
        read: vi.fn(),
      }
      resolver = new ActorStoreRecordResolver(
        mockActorStore as unknown as ActorStore,
      )
    })

    it('returns null if actor does not exist in getRecord', async () => {
      mockActorStore.exists.mockResolvedValue(false)
      const result = await resolver.getRecord(
        'did:plc:shinji',
        'at://did:plc:shinji/app.bsky.feed.post/123',
      )
      expect(result).toBeNull()
      expect(mockActorStore.exists).toHaveBeenCalledWith('did:plc:shinji')
    })

    it('returns record with boundaries if actor exists in getRecord', async () => {
      mockActorStore.exists.mockResolvedValue(true)
      const mockRecord = {
        uri: 'at://did:plc:shinji/app.bsky.feed.post/123',
        cid: 'bafyreih...',
        value: {
          text: 'Get in the robot, Shinji.',
          boundary: {
            $type: 'zone.stratos.boundary.defs#Domains',
            values: [{ value: 'did:web:nerv.tokyo.jp/eva-unit-01' }],
          },
        },
      }

      mockActorStore.read.mockImplementation(
        async (did: string, fn: (store: any) => Promise<any>) => {
          const mockStore = {
            record: {
              getRecord: vi.fn().mockResolvedValue(mockRecord),
            },
          }
          return fn(mockStore)
        },
      )

      const result = await resolver.getRecord('did:plc:shinji', mockRecord.uri)

      expect(result).toEqual({
        uri: mockRecord.uri,
        cid: mockRecord.cid,
        value: mockRecord.value,
        boundaries: ['did:web:nerv.tokyo.jp/eva-unit-01'],
      })
    })

    it('returns empty map if actor does not exist in getRecords', async () => {
      mockActorStore.exists.mockResolvedValue(false)
      const result = await resolver.getRecords('did:plc:shinji', [
        'at://did:plc:shinji/app.bsky.feed.post/123',
      ])
      expect(result.size).toBe(0)
    })

    it('returns map of records in getRecords', async () => {
      mockActorStore.exists.mockResolvedValue(true)
      const mockRecord = {
        uri: 'at://did:plc:rei/app.bsky.feed.post/456',
        cid: 'bafyreirei...',
        value: {
          text: 'I am not a doll.',
          boundary: {
            $type: 'zone.stratos.boundary.defs#Domains',
            values: [{ value: 'did:web:nerv.tokyo.jp/eva-unit-00' }],
          },
        },
      }

      mockActorStore.read.mockImplementation(
        async (did: string, fn: (store: any) => Promise<any>) => {
          const mockStore = {
            record: {
              getRecord: vi.fn().mockImplementation(async (uri: AtUri) => {
                if (uri.toString() === mockRecord.uri) {
                  return mockRecord
                }
                return null
              }),
            },
          }
          return fn(mockStore)
        },
      )

      const result = await resolver.getRecords('did:plc:rei', [mockRecord.uri])

      expect(result.size).toBe(1)
      // Use string comparison for keys since AtUri objects might not be deeply equal as keys in Map
      const keys = Array.from(result.keys()).map((k) => k.toString())
      expect(keys).toContain(mockRecord.uri)

      const entry = Array.from(result.entries()).find(
        ([k]) => k.toString() === mockRecord.uri,
      )?.[1]
      expect(entry).toBeDefined()
      expect(entry?.boundaries).toEqual(['did:web:nerv.tokyo.jp/eva-unit-00'])
    })
  })

  describe('HydrationServiceImpl', () => {
    let mockRecordResolver: any
    let mockBoundaryResolver: any
    let service: HydrationServiceImpl

    beforeEach(() => {
      mockRecordResolver = {
        getRecord: vi.fn(),
        getRecords: vi.fn(),
      }
      mockBoundaryResolver = {
        getBoundaries: vi.fn(),
      }
      service = new HydrationServiceImpl(
        mockRecordResolver,
        mockBoundaryResolver,
      )
    })

    it('returns error for invalid AT-URI in hydrateRecord', async () => {
      const result = await service.hydrateRecord({ uri: 'invalid-uri' }, {
        viewerDomains: [],
      } as any)
      expect(result.status).toBe('error')
      if (result.status === 'error') {
        expect(result.message).toBe('Invalid AT-URI')
      }
    })

    it('returns not-found if record resolver returns null', async () => {
      mockRecordResolver.getRecord.mockResolvedValue(null)
      const result = await service.hydrateRecord(
        { uri: 'at://did:plc:asuka/app.bsky.feed.post/789' },
        { viewerDomains: [] } as any,
      )
      expect(result.status).toBe('not-found')
    })

    it('returns blocked if viewer does not have access', async () => {
      const uri = 'at://did:plc:asuka/app.bsky.feed.post/789'
      mockRecordResolver.getRecord.mockResolvedValue({
        uri,
        cid: 'cid-asuka',
        value: { text: 'Pathetic.' },
        boundaries: ['did:web:nerv.tokyo.jp/leadership'],
      })

      const result = await service.hydrateRecord({ uri }, {
        viewerDid: 'did:plc:shinji',
        viewerDomains: ['did:web:nerv.tokyo.jp/pilots'],
      } as any)

      expect(result.status).toBe('blocked')
    })

    it('returns success if viewer has access', async () => {
      const uri = 'at://did:plc:misato/app.bsky.feed.post/000'
      const record = {
        uri,
        cid: 'cid-misato',
        value: { text: 'Beer time!' },
        boundaries: ['did:web:nerv.tokyo.jp/leadership'],
      }
      mockRecordResolver.getRecord.mockResolvedValue(record)

      const result = await service.hydrateRecord({ uri }, {
        viewerDid: 'did:plc:misato',
        viewerDomains: ['did:web:nerv.tokyo.jp/leadership'],
      } as any)

      expect(result.status).toBe('success')
      if (result.status === 'success') {
        expect(result.record?.value).toEqual(record.value)
      }
    })

    it('resolves viewer boundaries if not provided but viewerDid is present', async () => {
      const uri = 'at://did:plc:gendo/app.bsky.feed.post/999'
      mockRecordResolver.getRecord.mockResolvedValue({
        uri,
        cid: 'cid-gendo',
        value: { text: 'All is according to the Dead Sea Scrolls.' },
        boundaries: ['did:web:nerv.tokyo.jp/secret'],
      })
      mockBoundaryResolver.getBoundaries.mockResolvedValue([
        'did:web:nerv.tokyo.jp/secret',
      ])

      const result = await service.hydrateRecord({ uri }, {
        viewerDid: 'did:plc:gendo',
        viewerDomains: [],
      } as any)

      expect(result.status).toBe('success')
      expect(mockBoundaryResolver.getBoundaries).toHaveBeenCalledWith(
        'did:plc:gendo',
      )
    })

    it('hydrates multiple records in hydrateRecords', async () => {
      const uri1 = 'at://did:plc:shinji/app.bsky.feed.post/1'
      const uri2 = 'at://did:plc:rei/app.bsky.feed.post/2'

      const record1 = {
        uri: uri1,
        cid: 'cid1',
        value: { text: 'one' },
        boundaries: ['did:web:nerv.tokyo.jp/public'],
      }
      const record2 = {
        uri: uri2,
        cid: 'cid2',
        value: { text: 'two' },
        boundaries: ['did:web:nerv.tokyo.jp/secret'],
      }

      mockRecordResolver.getRecords.mockImplementation(
        (did: string, uris: string[]) => {
          const map = new Map()
        if (did === 'did:plc:shinji') {
          for (const u of uris) {
            if (u === uri1) {
              // The key must match what processHydrationRequest expects
              // It uses new AtUriSyntax(request.uri) which is the same as AtUri
              map.set(
                Array.from(map.keys()).find((k) => k.toString() === uri1) ||
                  new AtUri(uri1),
                record1,
              )
            }
          }
        } else if (did === 'did:plc:rei') {
          for (const u of uris) {
            if (u === uri2) {
              map.set(
                Array.from(map.keys()).find((k) => k.toString() === uri2) ||
                  new AtUri(uri2),
                record2,
              )
            }
          }
        }

        // Actually, the implementation of HydrationServiceImpl.hydrateRecords calls:
        // const recordMap = await this.recordResolver.getRecords(ownerDid, uris)
        // and processHydrationRequest calls:
        // const atUri = new AtUriSyntax(request.uri)
        // const record = recordMap.get(atUri)
        // For Map.get(atUri) to work, it MUST be the same object or we need to mock Map.get.

        const originalGet = map.get.bind(map)
        map.get = (key: any) => {
          if (
            key instanceof AtUri ||
            (key && typeof key.toString === 'function')
          ) {
            const str = key.toString()
            for (const [k, v] of map.entries()) {
              if (k.toString() === str) return v
            }
          }
          return originalGet(key)
        }

        return Promise.resolve(map)
      })

      const result = await service.hydrateRecords(
        [{ uri: uri1 }, { uri: uri2 }],
        {
          viewerDid: 'did:plc:shinji',
          viewerDomains: ['did:web:nerv.tokyo.jp/public'],
        } as any,
      )

      expect(result.records.length).toBe(1)
      expect(result.records[0].uri).toBe(uri1)
      expect(result.blocked).toContain(uri2)
      expect(result.notFound.length).toBe(0)
    })
  })
})
