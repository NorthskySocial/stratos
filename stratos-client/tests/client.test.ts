import { describe, it, expect, vi, beforeEach } from 'vitest'

import { discoverEnrollment } from '../src/discovery.js'
import { createServiceFetchHandler, resolveServiceUrl } from '../src/routing.js'
import {
  buildCollectionScope,
  buildStratosScopes,
  STRATOS_SCOPES,
} from '../src/scopes.js'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('discovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns enrollment when record exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        uri: 'at://did:plc:test123/app.stratos.actor.enrollment/self',
        cid: 'bafytest',
        value: {
          service: 'https://stratos.example.com',
          boundaries: [{ value: 'cosplayers' }],
          createdAt: '2025-01-01T00:00:00Z',
        },
      }),
    )

    const result = await discoverEnrollment(
      'did:plc:test123',
      'https://pds.example.com',
    )

    expect(result).toEqual({
      service: 'https://stratos.example.com',
      boundaries: [{ value: 'cosplayers' }],
      createdAt: '2025-01-01T00:00:00Z',
    })

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('com.atproto.repo.getRecord'),
      expect.anything(),
    )
  })

  it('returns null when record does not exist', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: 'RecordNotFound', message: 'not found' }, 400),
    )

    const result = await discoverEnrollment(
      'did:plc:test123',
      'https://pds.example.com',
    )
    expect(result).toBeNull()
  })

  it('returns null when record has invalid shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        uri: 'at://did:plc:test123/app.stratos.actor.enrollment/self',
        cid: 'bafytest',
        value: { invalid: true },
      }),
    )

    const result = await discoverEnrollment(
      'did:plc:test123',
      'https://pds.example.com',
    )
    expect(result).toBeNull()
  })

  it('normalizes missing boundaries to empty array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        uri: 'at://did:plc:test123/app.stratos.actor.enrollment/self',
        cid: 'bafytest',
        value: {
          service: 'https://stratos.example.com',
          createdAt: '2025-01-01T00:00:00Z',
        },
      }),
    )

    const result = await discoverEnrollment(
      'did:plc:test123',
      'https://pds.example.com',
    )
    expect(result?.boundaries).toEqual([])
  })

  it('accepts a FetchHandler instead of a PDS URL', async () => {
    const mockHandler = vi.fn(async (_pathname: string, _init: RequestInit) =>
      jsonResponse({
        uri: 'at://did:plc:test123/app.stratos.actor.enrollment/self',
        cid: 'bafytest',
        value: {
          service: 'https://stratos.example.com',
          boundaries: [],
          createdAt: '2025-01-01T00:00:00Z',
        },
      }),
    )

    const result = await discoverEnrollment('did:plc:test123', mockHandler)

    expect(result).toEqual({
      service: 'https://stratos.example.com',
      boundaries: [],
      createdAt: '2025-01-01T00:00:00Z',
    })
    expect(mockHandler).toHaveBeenCalledWith(
      expect.stringContaining('com.atproto.repo.getRecord'),
      expect.anything(),
    )
  })
})

describe('routing', () => {
  describe('createServiceFetchHandler', () => {
    it('routes calls to the target service URL', async () => {
      const mockHandler = vi.fn(async () => new Response('ok'))
      const handler = createServiceFetchHandler(
        mockHandler,
        'https://stratos.example.com',
      )

      await handler.handle('/xrpc/app.stratos.feed.post')

      expect(mockHandler).toHaveBeenCalledWith(
        'https://stratos.example.com/xrpc/app.stratos.feed.post',
        undefined,
      )
    })

    it('passes through RequestInit options', async () => {
      const mockHandler = vi.fn(async () => new Response('ok'))
      const handler = createServiceFetchHandler(
        mockHandler,
        'https://stratos.example.com',
      )
      const init: RequestInit = { method: 'POST', body: '{}' }

      await handler.handle('/xrpc/com.atproto.repo.createRecord', init)

      expect(mockHandler).toHaveBeenCalledWith(
        'https://stratos.example.com/xrpc/com.atproto.repo.createRecord',
        init,
      )
    })

    it('handles pathnames with query parameters', async () => {
      const mockHandler = vi.fn(async () => new Response('ok'))
      const handler = createServiceFetchHandler(
        mockHandler,
        'https://stratos.example.com',
      )

      await handler.handle(
        '/xrpc/com.atproto.repo.getRecord?repo=did:plc:test&collection=app.stratos.feed.post&rkey=abc',
      )

      expect(mockHandler).toHaveBeenCalledWith(
        'https://stratos.example.com/xrpc/com.atproto.repo.getRecord?repo=did:plc:test&collection=app.stratos.feed.post&rkey=abc',
        undefined,
      )
    })
  })

  describe('resolveServiceUrl', () => {
    it('returns enrollment service URL when enrolled', () => {
      const url = resolveServiceUrl(
        { service: 'https://stratos.example.com' },
        'https://pds.example.com',
      )
      expect(url).toBe('https://stratos.example.com')
    })

    it('returns fallback URL when not enrolled', () => {
      const url = resolveServiceUrl(null, 'https://pds.example.com')
      expect(url).toBe('https://pds.example.com')
    })
  })
})

describe('scopes', () => {
  it('has correct default scope identifiers', () => {
    expect(STRATOS_SCOPES.enrollment).toBe('app.stratos.actor.enrollment')
    expect(STRATOS_SCOPES.post).toBe('app.stratos.feed.post')
  })

  it('builds collection scope with default abilities', () => {
    const scope = buildCollectionScope('app.stratos.feed.post')
    expect(scope).toBe('repo:app.stratos.feed.post:create,update,delete')
  })

  it('builds collection scope with custom abilities', () => {
    const scope = buildCollectionScope('app.stratos.feed.post', ['create'])
    expect(scope).toBe('repo:app.stratos.feed.post:create')
  })

  it('builds full Stratos scope set', () => {
    const scopes = buildStratosScopes()
    expect(scopes).toContain('transition:generic')
    expect(scopes).toContain('transition:chat.bsky')
    expect(scopes).toContain(
      'repo:app.stratos.actor.enrollment:create,update,delete',
    )
    expect(scopes).toContain('repo:app.stratos.feed.post:create,update,delete')
  })
})
