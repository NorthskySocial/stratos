import { afterEach, describe, expect, it, vi } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import { encode as cborEncode } from '@atcute/cbor'

import {
  createServiceFetchHandler,
  discoverEnrollment,
  discoverEnrollments,
  resolveServiceSigningKey,
  verifyEnrollmentAttestation,
  verifyRecordCid,
  verifyStratosRecord,
} from '../src/index.js'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const MOCK_SIG = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
const MOCK_SIG_B64 = btoa(String.fromCharCode(...MOCK_SIG))
const MOCK_USER_KEY = 'did:key:zDnaeUserSigningKey123'
const MOCK_SERVICE_KEY = 'did:key:zDnaeServiceKey456'

const enrollmentValue = (overrides?: Record<string, unknown>) => ({
  service: 'https://stratos.example.com',
  boundaries: [{ value: 'cosplayers' }],
  signingKey: MOCK_USER_KEY,
  attestation: {
    sig: { $bytes: MOCK_SIG_B64 },
    signingKey: MOCK_SERVICE_KEY,
  },
  createdAt: '2025-01-01T00:00:00Z',
  ...overrides,
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('discoverEnrollments', () => {
  it('lists and parses all valid enrollment records', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        records: [
          {
            uri: 'at://did:plc:test123/zone.stratos.actor.enrollment/did:web:a.example.com',
            value: enrollmentValue(),
          },
          {
            uri: 'at://did:plc:test123/zone.stratos.actor.enrollment/did:web:b.example.com',
            value: enrollmentValue({ service: 'https://b.example.com' }),
          },
          {
            uri: 'at://did:plc:test123/zone.stratos.actor.enrollment/bad',
            value: { invalid: true },
          },
        ],
      }),
    )

    const result = await discoverEnrollments(
      'did:plc:test123',
      'https://pds.example.com',
    )

    expect(result).toHaveLength(2)
    expect(result[0].rkey).toBe('did:web:a.example.com')
    expect(result[1].service).toBe('https://b.example.com')
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('com.atproto.repo.listRecords'),
      expect.anything(),
    )
  })

  it('returns empty array on request failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 500))

    await expect(
      discoverEnrollments('did:plc:test123', 'https://pds.example.com'),
    ).resolves.toEqual([])
  })

  it('returns empty array when fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))

    await expect(
      discoverEnrollments('did:plc:test123', 'https://pds.example.com'),
    ).resolves.toEqual([])
  })
})

describe('discoverEnrollment', () => {
  it('returns the first enrollment', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        records: [
          {
            uri: 'at://did:plc:test123/zone.stratos.actor.enrollment/did:web:a.example.com',
            value: enrollmentValue(),
          },
        ],
      }),
    )

    const result = await discoverEnrollment(
      'did:plc:test123',
      'https://pds.example.com',
    )
    expect(result?.rkey).toBe('did:web:a.example.com')
  })

  it('returns null when no enrollments exist', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ records: [] }),
    )

    await expect(
      discoverEnrollment('did:plc:test123', 'https://pds.example.com'),
    ).resolves.toBeNull()
  })
})

describe('createServiceFetchHandler headers option', () => {
  it('sets extra headers on every routed request', async () => {
    const mockHandler = vi.fn(async () => new Response('ok'))
    const handler = createServiceFetchHandler(
      mockHandler,
      'https://stratos.example.com',
      { headers: { 'ngrok-skip-browser-warning': '1' } },
    )

    await handler.handle('/xrpc/zone.stratos.feed.getTimeline', {
      headers: { 'x-existing': 'yes' },
    })

    const [url, init] = mockHandler.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(url).toBe(
      'https://stratos.example.com/xrpc/zone.stratos.feed.getTimeline',
    )
    const headers = new Headers(init.headers)
    expect(headers.get('ngrok-skip-browser-warning')).toBe('1')
    expect(headers.get('x-existing')).toBe('yes')
  })

  it('does not touch headers when no options are given', async () => {
    const mockHandler = vi.fn(async () => new Response('ok'))
    const handler = createServiceFetchHandler(
      mockHandler,
      'https://stratos.example.com',
    )

    const init = { method: 'GET' }
    await handler.handle('/xrpc/test', init)
    expect(mockHandler).toHaveBeenCalledWith(
      'https://stratos.example.com/xrpc/test',
      init,
    )
  })
})

describe('resolveServiceSigningKey cache option', () => {
  const didDocFor = (did: string, publicKeyMultibase: string) =>
    jsonResponse({
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/multikey/v1',
      ],
      id: did,
      verificationMethod: [
        {
          id: `${did}#atproto`,
          type: 'Multikey',
          controller: did,
          publicKeyMultibase,
        },
      ],
    })

  it('memoizes successful resolutions in the provided cache', async () => {
    const keypair = await Secp256k1Keypair.create()
    const multibase = keypair.did().slice('did:key:'.length)
    const did = 'did:web:cached.example.com'
    const mockFetch = vi.fn(async () => didDocFor(did, multibase))

    const cache = new Map()
    const first = await resolveServiceSigningKey(did, {
      fetchFn: mockFetch,
      cache,
    })
    const second = await resolveServiceSigningKey(did, {
      fetchFn: mockFetch,
      cache,
    })

    expect(first).toBe(second)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(cache.size).toBe(1)
  })

  it('does not cache without an explicit cache', async () => {
    const keypair = await Secp256k1Keypair.create()
    const multibase = keypair.did().slice('did:key:'.length)
    const did = 'did:web:uncached.example.com'
    const mockFetch = vi.fn(async () => didDocFor(did, multibase))

    await resolveServiceSigningKey(did, { fetchFn: mockFetch })
    await resolveServiceSigningKey(did, { fetchFn: mockFetch })

    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})

describe('verifyEnrollmentAttestation', () => {
  const USER_DID = 'did:plc:enrolleduser'

  const makeAttestedRecord = async () => {
    const serviceKeypair = await Secp256k1Keypair.create()
    const userSigningKey =
      'did:key:zQ3shokFTS3LRDLqSbxDBZ5S4vS34C2Bv6N58K7Y72v4w4'
    const boundaries = [{ value: 'engineering' }, { value: 'cosplayers' }]

    const payload = cborEncode({
      boundaries: boundaries.map((b) => b.value).sort(),
      did: USER_DID,
      signingKey: userSigningKey,
    })
    const sig = await serviceKeypair.sign(payload)

    return {
      serviceKeypair,
      record: {
        service: 'https://stratos.example.com',
        signingKey: userSigningKey,
        boundaries,
        attestation: {
          sig: new Uint8Array(sig),
          signingKey: serviceKeypair.did(),
        },
        createdAt: '2025-01-01T00:00:00Z',
      },
    }
  }

  it('accepts a valid attestation', async () => {
    const { record } = await makeAttestedRecord()

    const result = await verifyEnrollmentAttestation(record, USER_DID)

    expect(result.valid).toBe(true)
    expect(result.serviceKey).toBe(record.attestation.signingKey)
    expect(result.userSigningKey).toBe(record.signingKey)
    expect(result.boundaries).toEqual(['cosplayers', 'engineering'])
    expect(result.error).toBeUndefined()
  })

  it('rejects when the payload was signed for a different DID', async () => {
    const { record } = await makeAttestedRecord()

    const result = await verifyEnrollmentAttestation(record, 'did:plc:other')

    expect(result.valid).toBe(false)
  })

  it('rejects when boundaries were tampered with', async () => {
    const { record } = await makeAttestedRecord()
    record.boundaries.push({ value: 'sneaky' })

    const result = await verifyEnrollmentAttestation(record, USER_DID)

    expect(result.valid).toBe(false)
  })

  it('rejects records without attestation fields', async () => {
    const result = await verifyEnrollmentAttestation({ service: 'x' }, USER_DID)

    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/missing attestation/)
  })

  it('handles $bytes-encoded signatures', async () => {
    const { record } = await makeAttestedRecord()
    const sig = record.attestation.sig as Uint8Array
    const recordWithB64 = {
      ...record,
      attestation: {
        ...record.attestation,
        sig: { $bytes: btoa(String.fromCharCode(...sig)) },
      },
    }

    const result = await verifyEnrollmentAttestation(recordWithB64, USER_DID)
    expect(result.valid).toBe(true)
  })
})

describe('verifyStratosRecord', () => {
  it('falls back to cid-integrity when no serviceDid is given', async () => {
    const { buildSignedTestCar } = await import('./helpers/test-car.js')
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const { carBytes } = await buildSignedTestCar(
      keypair,
      'did:plc:testverify',
      'zone.stratos.feed.post',
      'abc123',
    )

    const result = await verifyStratosRecord(
      carBytes,
      'did:plc:testverify',
      'zone.stratos.feed.post',
      'abc123',
    )

    expect(result.level).toBe('cid-integrity')
  })

  it('falls back to cid-integrity when key resolution fails', async () => {
    const { buildSignedTestCar } = await import('./helpers/test-car.js')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unreachable'))

    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const { carBytes } = await buildSignedTestCar(
      keypair,
      'did:plc:testverify',
      'zone.stratos.feed.post',
      'abc123',
    )

    const result = await verifyStratosRecord(
      carBytes,
      'did:plc:testverify',
      'zone.stratos.feed.post',
      'abc123',
      'did:web:unreachable.example.com',
    )

    expect(result.level).toBe('cid-integrity')
  })

  it('verifies the service signature when the DID document resolves', async () => {
    const { buildSignedTestCar } = await import('./helpers/test-car.js')
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const multibase = keypair.did().slice('did:key:'.length)
    const serviceDid = 'did:web:sigservice.example.com'

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        '@context': [
          'https://www.w3.org/ns/did/v1',
          'https://w3id.org/security/multikey/v1',
        ],
        id: serviceDid,
        verificationMethod: [
          {
            id: `${serviceDid}#atproto`,
            type: 'Multikey',
            controller: serviceDid,
            publicKeyMultibase: multibase,
          },
        ],
      }),
    )

    const { carBytes } = await buildSignedTestCar(
      keypair,
      'did:plc:testverify',
      'zone.stratos.feed.post',
      'abc123',
    )

    const result = await verifyStratosRecord(
      carBytes,
      'did:plc:testverify',
      'zone.stratos.feed.post',
      'abc123',
      serviceDid,
    )

    expect(result.level).toBe('service-signature')
    expect(result.cid).toBeTruthy()
  })

  it('rejects when the commit signature does not match the service key', async () => {
    const { buildSignedTestCar } = await import('./helpers/test-car.js')
    const commitKeypair = await Secp256k1Keypair.create({ exportable: true })
    const wrongKeypair = await Secp256k1Keypair.create({ exportable: true })
    const multibase = wrongKeypair.did().slice('did:key:'.length)
    const serviceDid = 'did:web:wrongsig.example.com'

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        '@context': [
          'https://www.w3.org/ns/did/v1',
          'https://w3id.org/security/multikey/v1',
        ],
        id: serviceDid,
        verificationMethod: [
          {
            id: `${serviceDid}#atproto`,
            type: 'Multikey',
            controller: serviceDid,
            publicKeyMultibase: multibase,
          },
        ],
      }),
    )

    const { carBytes } = await buildSignedTestCar(
      commitKeypair,
      'did:plc:testverify',
      'zone.stratos.feed.post',
      'abc123',
    )

    await expect(
      verifyStratosRecord(
        carBytes,
        'did:plc:testverify',
        'zone.stratos.feed.post',
        'abc123',
        serviceDid,
      ),
    ).rejects.toThrow()
  })
})

describe('verifyRecordCid', () => {
  const makeRecord = async () => {
    const { encode } = await import('@atcute/cbor')
    const { create, toString, CODEC_DCBOR } = await import('@atcute/cid')
    const value = {
      $type: 'zone.stratos.feed.post',
      text: 'hello boundaries',
      createdAt: '2025-01-01T00:00:00Z',
      embed: {
        ref: {
          $link: 'bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqrsgxs3n2y3q',
        },
      },
    }
    const cid = toString(await create(CODEC_DCBOR, encode(value)))
    return { value, cid }
  }

  it('accepts a record whose value matches the claimed CID', async () => {
    const { value, cid } = await makeRecord()

    const result = await verifyRecordCid(value, cid)

    expect(result.level).toBe('cid-integrity')
    expect(result.cid).toBe(cid)
    expect(result.record).toBe(value)
  })

  it('rejects when the value was tampered with', async () => {
    const { value, cid } = await makeRecord()
    const tampered = { ...value, text: 'evil edit' }

    await expect(verifyRecordCid(tampered, cid)).rejects.toThrow(/CID mismatch/)
  })

  it('rejects when the claimed CID is wrong', async () => {
    const { value } = await makeRecord()

    await expect(
      verifyRecordCid(
        value,
        'bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqrsgxs3n2y3q',
      ),
    ).rejects.toThrow(/CID mismatch/)
  })

  it('handles $bytes fields in JSON interchange form', async () => {
    const { encode } = await import('@atcute/cbor')
    const { create, toString, CODEC_DCBOR } = await import('@atcute/cid')
    const value = {
      $type: 'zone.stratos.actor.enrollment',
      attestation: { sig: { $bytes: 'AQID' }, signingKey: 'did:key:zTest' },
    }
    const cid = toString(await create(CODEC_DCBOR, encode(value)))

    const result = await verifyRecordCid(value, cid)
    expect(result.cid).toBe(cid)
  })
})
