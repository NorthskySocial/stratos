/**
 * Unit tests for stub module domain logic
 */
import { describe, expect, it } from 'vitest'
import { CID } from '@atproto/lex-data'
import { sha256 } from 'multiformats/hashes/sha2'
import {
  extractSource,
  generateStub,
  isStubRecord,
  parseServiceDid,
} from '../src/index.js'

// Helper to create deterministic CID
async function createCid(data: string): Promise<CID> {
  const bytes = new TextEncoder().encode(data)
  const hash = await sha256.digest(bytes)
  return CID.createV1(0x55, hash)
}

describe('Stub Domain', () => {
  describe('generateStub', () => {
    it('should generate a stub with source field', async () => {
      const cid = await createCid('test record')
      const stub = generateStub({
        uri: 'at://did:plc:abc123/zone.stratos.feed.post/123',
        cid,
        recordType: 'zone.stratos.feed.post',
        createdAt: '2024-01-01T00:00:00.000Z',
        serviceDid: 'did:web:stratos.example.com#atproto_pns',
      })

      expect(stub.$type).toBe('zone.stratos.feed.post')
      expect(stub.createdAt).toBe('2024-01-01T00:00:00.000Z')
      expect(stub.source).toBeDefined()
      expect(stub.source.vary).toBe('authenticated')
      expect(stub.source.subject.uri).toBe(
        'at://did:plc:abc123/zone.stratos.feed.post/123',
      )
      expect(stub.source.subject.cid).toBe(cid.toString())
      expect(stub.source.service).toBe(
        'did:web:stratos.example.com#atproto_pns',
      )
    })

    it('should preserve recordType as $type', async () => {
      const cid = await createCid('another record')
      const stub = generateStub({
        uri: 'at://did:plc:xyz/zone.stratos.graph.follow/abc',
        cid,
        recordType: 'zone.stratos.graph.follow',
        createdAt: '2024-06-15T12:00:00.000Z',
        serviceDid: 'did:plc:myservice#atproto_pns',
      })

      expect(stub.$type).toBe('zone.stratos.graph.follow')
    })
  })

  describe('isStubRecord', () => {
    it('should return true for valid stub record', () => {
      const stub = {
        $type: 'zone.stratos.feed.post',
        source: {
          vary: 'authenticated',
          subject: {
            uri: 'at://did:plc:test/zone.stratos.feed.post/1',
            cid: 'bafytest',
          },
          service: 'did:plc:service#atproto_pns',
        },
        createdAt: '2024-01-01T00:00:00.000Z',
      }

      expect(isStubRecord(stub)).toBe(true)
    })

    it('should return false for full record without source', () => {
      const fullRecord = {
        $type: 'zone.stratos.feed.post',
        text: 'Hello world',
        boundary: { values: [{ value: 'example.com' }] },
        createdAt: '2024-01-01T00:00:00.000Z',
      }

      expect(isStubRecord(fullRecord)).toBe(false)
    })

    it('should return false for null', () => {
      expect(isStubRecord(null)).toBe(false)
    })

    it('should return false for undefined', () => {
      expect(isStubRecord(undefined)).toBe(false)
    })

    it('should return false for primitive values', () => {
      expect(isStubRecord('string')).toBe(false)
      expect(isStubRecord(123)).toBe(false)
      expect(isStubRecord(true)).toBe(false)
    })

    it('should return false for incomplete source field', () => {
      const incomplete = {
        source: {
          vary: 'authenticated',
          // missing subject and service
        },
      }

      expect(isStubRecord(incomplete)).toBe(false)
    })
  })

  describe('extractSource', () => {
    it('should extract source from stub record', () => {
      const stub = {
        $type: 'zone.stratos.feed.post',
        source: {
          vary: 'authenticated',
          subject: {
            uri: 'at://did:plc:test/zone.stratos.feed.post/1',
            cid: 'bafytest',
          },
          service: 'did:plc:service#atproto_pns',
        },
        createdAt: '2024-01-01T00:00:00.000Z',
      }

      const source = extractSource(stub)
      expect(source).toBeDefined()
      expect(source?.vary).toBe('authenticated')
      expect(source?.subject.uri).toBe(
        'at://did:plc:test/zone.stratos.feed.post/1',
      )
      expect(source?.service).toBe('did:plc:service#atproto_pns')
    })

    it('should return null for non-stub record', () => {
      const fullRecord = {
        text: 'Hello',
        boundary: { values: [] },
        createdAt: '2024-01-01T00:00:00.000Z',
      }

      expect(extractSource(fullRecord)).toBeNull()
    })
  })

  describe('parseServiceDid', () => {
    it('should parse DID with fragment', () => {
      const result = parseServiceDid('did:plc:abc123#atproto_pns')
      expect(result.did).toBe('did:plc:abc123')
      expect(result.fragment).toBe('atproto_pns')
    })

    it('should parse DID without fragment', () => {
      const result = parseServiceDid('did:plc:abc123')
      expect(result.did).toBe('did:plc:abc123')
      expect(result.fragment).toBeNull()
    })

    it('should handle did:web with fragment', () => {
      const result = parseServiceDid('did:web:stratos.example.com#atproto_pns')
      expect(result.did).toBe('did:web:stratos.example.com')
      expect(result.fragment).toBe('atproto_pns')
    })

    it('should handle multiple # characters (take first)', () => {
      const result = parseServiceDid('did:plc:test#fragment#extra')
      expect(result.did).toBe('did:plc:test')
      expect(result.fragment).toBe('fragment#extra')
    })
  })
})
