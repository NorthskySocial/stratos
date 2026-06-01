import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseAtUri,
  resolvePdsEndpoint,
  fetchPdsStub,
  fetchHydratedRecord,
  inspectRecord,
  syntaxHighlightJson,
} from '../src/lib/inspector'
import type { OAuthSession } from '@atproto/oauth-client-browser'

describe('inspector logic', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn() as unknown as typeof fetch
  })

  describe('parseAtUri', () => {
    it('parses valid AT URIs', () => {
      expect(parseAtUri('at://did:plc:123/app.bsky.feed.post/456')).toEqual({
        did: 'did:plc:123',
        collection: 'app.bsky.feed.post',
        rkey: '456',
      })
    })

    it('handles incomplete URIs', () => {
      expect(parseAtUri('at://did:plc:123')).toEqual({
        did: 'did:plc:123',
        collection: '',
        rkey: '',
      })
    })
  })

  describe('resolvePdsEndpoint', () => {
    it('resolves did:plc correctly', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          service: [
            { id: '#atproto_pds', serviceEndpoint: 'https://pds.example.com' },
          ],
        }),
      } as Response)

      const endpoint = await resolvePdsEndpoint('did:plc:123')
      expect(endpoint).toBe('https://pds.example.com')
      expect(global.fetch).toHaveBeenCalledWith(
        'https://plc.directory/did%3Aplc%3A123',
      )
    })

    it('resolves did:web correctly', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          service: [
            { id: '#atproto_pds', serviceEndpoint: 'https://pds.web.com' },
          ],
        }),
      } as Response)

      const endpoint = await resolvePdsEndpoint('did:web:example.com')
      expect(endpoint).toBe('https://pds.web.com')
      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com/.well-known/did.json',
      )
    })

    it('throws error on failed resolution', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 404,
      } as Response)
      await expect(resolvePdsEndpoint('did:plc:123')).rejects.toThrow(
        'PLC directory lookup failed: 404',
      )
    })

    it('throws error for unsupported method', async () => {
      await expect(resolvePdsEndpoint('did:key:123')).rejects.toThrow(
        'Unsupported DID method: did:key:123',
      )
    })
  })

  describe('fetchPdsStub', () => {
    it('fetches record stub from PDS', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ value: { text: 'stub' } }),
      } as Response)

      const stub = await fetchPdsStub('https://pds.com', 'did:1', 'coll', 'key')
      expect(stub).toEqual({ value: { text: 'stub' } })
    })

    it('throws error on failure', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Error',
      } as Response)
      await expect(
        fetchPdsStub('https://pds.com', 'did:1', 'coll', 'key'),
      ).rejects.toThrow('PDS getRecord failed: 500 Error')
    })
  })

  describe('fetchHydratedRecord', () => {
    it('fetches hydrated record using session', async () => {
      const mockSession = {
        fetchHandler: vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ value: { text: 'hydrated' } }),
        }),
      } as unknown as OAuthSession

      const record = await fetchHydratedRecord(
        mockSession,
        'https://stratos.com',
        'at://did:1/coll/key',
      )
      expect(record).toEqual({ value: { text: 'hydrated' } })
      expect(mockSession.fetchHandler).toHaveBeenCalledWith(
        expect.stringContaining(
          '/xrpc/com.atproto.repo.getRecord?repo=did%3A1&collection=coll&rkey=key',
        ),
        { method: 'GET' },
      )
    })
  })

  describe('inspectRecord', () => {
    it('combines stub and hydrated record', async () => {
      // Mock resolvePdsEndpoint
      vi.mocked(global.fetch).mockImplementation((url: string) => {
        if (url.includes('plc.directory')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              service: [
                { id: '#atproto_pds', serviceEndpoint: 'https://pds.com' },
              ],
            }),
          } as Response)
        }
        if (url.includes('com.atproto.repo.getRecord')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ value: 'stub' }),
          } as Response)
        }
        return Promise.reject(new Error('Unknown URL'))
      })

      const mockSession = {
        fetchHandler: vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ value: 'hydrated' }),
        }),
      } as unknown as OAuthSession

      const result = await inspectRecord(
        mockSession,
        'https://stratos.com',
        'at://did:plc:1/coll/key',
      )
      expect(result.stub).toEqual({ value: 'stub' })
      expect(result.record).toEqual({ value: 'hydrated' })
      expect(result.stubError).toBeNull()
      expect(result.recordError).toBeNull()
    })

    it('handles partial failures', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'RecordNotFound',
      } as Response)
      const mockSession = {
        fetchHandler: vi.fn().mockRejectedValue(new Error('Stratos down')),
      } as unknown as OAuthSession

      const result = await inspectRecord(
        mockSession,
        'https://stratos.com',
        'at://did:plc:1/coll/key',
      )
      expect(result.stub).toBeNull()
      expect(result.stubNotFound).toBe(true)
      expect(result.record).toBeNull()
      expect(result.recordError).toBe('Stratos down')
    })
  })

  describe('syntaxHighlightJson', () => {
    it('highlights various types', () => {
      expect(syntaxHighlightJson(null)).toContain('json-null')
      expect(syntaxHighlightJson(true)).toContain('json-bool')
      expect(syntaxHighlightJson(123)).toContain('json-num')
      expect(syntaxHighlightJson('hello')).toContain('json-str')
      expect(syntaxHighlightJson({ key: 'val' })).toContain('json-key')
      expect(syntaxHighlightJson([1, 2])).toContain('[')
    })

    it('handles empty structures', () => {
      expect(syntaxHighlightJson({})).toBe('{}')
      expect(syntaxHighlightJson([])).toBe('[]')
    })
  })
})
