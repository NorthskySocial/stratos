import { beforeEach, describe, expect, it, vi } from 'vitest'

import { discoverEnrollment, discoverEnrollments } from '../src/index.js'
import {
  createServiceFetchHandler,
  findEnrollmentByService,
  resolveServiceUrl,
} from '../src/routing.js'
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

const MOCK_SIG = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
const MOCK_SIG_B64 = btoa(String.fromCharCode(...MOCK_SIG))
const MOCK_USER_KEY = 'did:key:zDnaeUserSigningKey123'
const MOCK_SERVICE_KEY = 'did:key:zDnaeServiceKey456'

const mockEnrollmentRecord = (valueOverrides?: Record<string, unknown>) => ({
  uri: 'at://did:plc:test123/zone.stratos.actor.enrollment/did:web:stratos.example.com',
  cid: 'bafytest',
  value: {
    service: 'https://stratos.example.com',
    boundaries: [{ value: 'cosplayers' }],
    signingKey: MOCK_USER_KEY,
    attestation: {
      sig: { $bytes: MOCK_SIG_B64 },
      signingKey: MOCK_SERVICE_KEY,
    },
    createdAt: '2025-01-01T00:00:00Z',
    ...valueOverrides,
  },
})

const mockListRecordsResponse = (
  records: ReturnType<typeof mockEnrollmentRecord>[],
) => ({
  records,
})

describe('discovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns enrollment when record exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(mockListRecordsResponse([mockEnrollmentRecord()])),
    )

    const result = await discoverEnrollment(
      'did:plc:test123',
      'https://pds.example.com',
    )

    expect(result).toEqual({
      service: 'https://stratos.example.com',
      boundaries: [{ value: 'cosplayers' }],
      signingKey: MOCK_USER_KEY,
      attestation: { sig: MOCK_SIG, signingKey: MOCK_SERVICE_KEY },
      createdAt: '2025-01-01T00:00:00Z',
      rkey: 'did:web:stratos.example.com',
    })
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('com.atproto.repo.listRecords'),
      expect.anything(),
    )
  })

  it('returns null when no enrollment records exist', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(mockListRecordsResponse([])),
    )

    const result = await discoverEnrollment(
      'did:plc:test123',
      'https://pds.example.com',
    )
    expect(result).toBeNull()
  })

  it('returns null when record has invalid shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        mockListRecordsResponse([
          {
            uri: 'at://did:plc:test123/zone.stratos.actor.enrollment/did:web:stratos.example.com',
            cid: 'bafytest',
            /* eslint-disable @typescript-eslint/no-explicit-any */
            value: { invalid: true } as any,
          },
        ]),
      ),
    )

    const result = await discoverEnrollment(
      'did:plc:test123',
      'https://pds.example.com',
    )
    expect(result).toBeNull()
  })

  it('normalizes missing boundaries to empty array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        mockListRecordsResponse([
          mockEnrollmentRecord({ boundaries: undefined }),
        ]),
      ),
    )

    const result = await discoverEnrollment(
      'did:plc:test123',
      'https://pds.example.com',
    )
    expect(result?.boundaries).toEqual([])
  })

  it('accepts a FetchHandler instead of a PDS URL', async () => {
    const mockHandler = vi.fn(async () =>
      jsonResponse(
        mockListRecordsResponse([mockEnrollmentRecord({ boundaries: [] })]),
      ),
    )

    const result = await discoverEnrollment('did:plc:test123', mockHandler)

    expect(result).toEqual({
      service: 'https://stratos.example.com',
      boundaries: [],
      signingKey: MOCK_USER_KEY,
      attestation: { sig: MOCK_SIG, signingKey: MOCK_SERVICE_KEY },
      createdAt: '2025-01-01T00:00:00Z',
      rkey: 'did:web:stratos.example.com',
    })
    expect(mockHandler).toHaveBeenCalledWith(
      expect.stringContaining('com.atproto.repo.listRecords'),
      expect.anything(),
    )
  })

  it('discovers multiple enrollments', async () => {
    const record1 = mockEnrollmentRecord()
    const record2 = {
      ...mockEnrollmentRecord({ service: 'https://stratos2.example.com' }),
      uri: 'at://did:plc:test123/zone.stratos.actor.enrollment/did:web:stratos2.example.com',
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(mockListRecordsResponse([record1, record2])),
    )

    const results = await discoverEnrollments(
      'did:plc:test123',
      'https://pds.example.com',
    )

    expect(results).toHaveLength(2)
    expect(results[0].rkey).toBe('did:web:stratos.example.com')
    expect(results[0].service).toBe('https://stratos.example.com')
    expect(results[1].rkey).toBe('did:web:stratos2.example.com')
    expect(results[1].service).toBe('https://stratos2.example.com')
  })

  it('returns empty array when no records exist', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(mockListRecordsResponse([])),
    )

    const results = await discoverEnrollments(
      'did:plc:test123',
      'https://pds.example.com',
    )
    expect(results).toEqual([])
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

      await handler.handle('/xrpc/zone.stratos.feed.post', {})

      expect(mockHandler).toHaveBeenCalledWith(
        'https://stratos.example.com/xrpc/zone.stratos.feed.post',
        {},
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
        '/xrpc/com.atproto.repo.getRecord?repo=did:plc:test&collection=zone.stratos.feed.post&rkey=abc',
        {},
      )

      expect(mockHandler).toHaveBeenCalledWith(
        'https://stratos.example.com/xrpc/com.atproto.repo.getRecord?repo=did:plc:test&collection=zone.stratos.feed.post&rkey=abc',
        {},
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

  describe('findEnrollmentByService', () => {
    const makeEnrollment = (service: string, rkey: string) => ({
      service,
      boundaries: [],
      signingKey: MOCK_USER_KEY,
      attestation: { sig: MOCK_SIG, signingKey: MOCK_SERVICE_KEY },
      createdAt: '2025-01-01T00:00:00Z',
      rkey,
    })

    it('finds enrollment matching service URL', () => {
      const enrollments = [
        makeEnrollment('https://stratos-a.example.com', 'rkey1'),
        makeEnrollment('https://stratos-b.example.com', 'rkey2'),
      ]
      const result = findEnrollmentByService(
        enrollments,
        'https://stratos-b.example.com',
      )
      expect(result?.rkey).toBe('rkey2')
    })

    it('matches with trailing slash normalization', () => {
      const enrollments = [
        makeEnrollment('https://stratos.example.com/', 'rkey1'),
      ]
      const result = findEnrollmentByService(
        enrollments,
        'https://stratos.example.com',
      )
      expect(result?.rkey).toBe('rkey1')
    })

    it('returns null when no match', () => {
      const enrollments = [
        makeEnrollment('https://stratos.example.com', 'rkey1'),
      ]
      const result = findEnrollmentByService(
        enrollments,
        'https://other.example.com',
      )
      expect(result).toBeNull()
    })

    it('returns null for empty array', () => {
      const result = findEnrollmentByService([], 'https://stratos.example.com')
      expect(result).toBeNull()
    })
  })
})

describe('scopes', () => {
  it('has correct default scope identifiers', () => {
    expect(STRATOS_SCOPES.enrollment).toBe('zone.stratos.actor.enrollment')
    expect(STRATOS_SCOPES.post).toBe('zone.stratos.feed.post')
  })

  it('builds collection scope with default abilities', () => {
    const scope = buildCollectionScope('zone.stratos.feed.post')
    expect(scope).toBe('repo:zone.stratos.feed.post')
  })

  it('builds collection scope with custom abilities', () => {
    const scope = buildCollectionScope('zone.stratos.feed.post', ['create'])
    expect(scope).toBe('repo:zone.stratos.feed.post?action=create')
  })

  it('builds collection scope with multiple custom abilities', () => {
    const scope = buildCollectionScope('zone.stratos.feed.post', [
      'create',
      'update',
    ])
    expect(scope).toBe(
      'repo:zone.stratos.feed.post?action=create&action=update',
    )
  })

  it('builds full Stratos scope set', () => {
    const scopes = buildStratosScopes()
    expect(scopes).toContain('atproto')
    expect(scopes).toContain('repo:zone.stratos.actor.enrollment')
    expect(scopes).toContain(
      'repo:zone.stratos.feed.post?action=create&action=delete',
    )
    expect(scopes).not.toContain('transition:generic')
    expect(scopes).not.toContain('transition:chat.bsky')
  })
})
