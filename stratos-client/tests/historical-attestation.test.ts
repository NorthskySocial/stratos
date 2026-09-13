import { readKeyHistoryResponse } from '../src/key-history-response.js'
import { describe, expect, it, vi } from 'vitest'
import { Secp256k1Keypair, P256Keypair } from '@atproto/crypto'
import { encode } from '@atcute/cbor'
import { appendServiceKeyHistory } from '../src/key-history.js'
import { verifyEnrollmentAttestation } from '../src/attestation.js'
import { resolveServiceSigningKey } from '../src/verification.js'

const did = 'did:web:nerv.example'
const userDid = 'did:plc:shinji'
const issuedAt = '1995-10-04T12:00:00.000Z'
async function fixture() {
  const shinji = await Secp256k1Keypair.create({ exportable: true })
  const rei = await P256Keypair.create({ exportable: true })
  const genesis = await appendServiceKeyHistory(
    { serviceDid: did, entries: [] },
    shinji,
    shinji,
    '1995-10-04T00:00:00.000Z',
  )
  const history = await appendServiceKeyHistory(
    genesis,
    shinji,
    rei,
    '1995-10-05T00:00:00.000Z',
  )
  const doc = {
    id: did,
    verificationMethod: [
      {
        id: `${did}#atproto`,
        controller: did,
        type: 'Multikey',
        publicKeyMultibase: rei.did().slice(8),
      },
    ],
    service: [
      {
        id: '#stratos',
        type: 'StratosService',
        serviceEndpoint: 'https://nerv.example',
      },
    ],
  }
  const fetchFn = vi.fn<typeof fetch>(async (url) =>
    Response.json(String(url).includes('getKeyHistory') ? history : doc),
  )
  const record = {
    signingKey: 'did:key:zActorKey',
    boundaries: [{ value: `${did}/engineering` }],
    attestation: {
      signingKey: shinji.did(),
      issuedAt,
      sig: await shinji.sign(
        encode({
          did: userDid,
          signingKey: 'did:key:zActorKey',
          boundaries: [`${did}/engineering`],
          issuedAt,
        }),
      ),
    },
  }
  return {
    shinji,
    rei,
    record,
    history,
    doc,
    fetchFn,
    options: { serviceDid: did, fetchFn },
  }
}

describe('attestation service identity binding', () => {
  it('authenticates a historical key and its signed timestamp', async () => {
    const { record, fetchFn, options } = await fixture()
    expect(
      await verifyEnrollmentAttestation(record, userDid, options),
    ).toMatchObject({ valid: true })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(fetchFn.mock.calls[1]).toEqual([
      'https://nerv.example/xrpc/zone.stratos.identity.getKeyHistory',
      expect.objectContaining({
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    ])
  })
  it('fast-paths a current key without fetching history', async () => {
    const { record, doc, shinji, fetchFn, options } = await fixture()
    doc.verificationMethod[0].publicKeyMultibase = shinji.did().slice(8)
    expect(
      (await verifyEnrollmentAttestation(record, userDid, options)).valid,
    ).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it('retains current-key verification for legacy signatures but rejects historic legacy signatures', async () => {
    const { record, doc, shinji, options } = await fixture()
    const legacy = {
      ...record,
      attestation: {
        signingKey: shinji.did(),
        sig: await shinji.sign(
          encode({
            did: userDid,
            signingKey: record.signingKey,
            boundaries: record.boundaries.map((b) => b.value),
          }),
        ),
      },
    }
    expect(
      (await verifyEnrollmentAttestation(legacy, userDid, options)).error,
    ).toContain('signed issuedAt')
    doc.verificationMethod[0].publicKeyMultibase = shinji.did().slice(8)
    expect(
      (await verifyEnrollmentAttestation(legacy, userDid, options)).valid,
    ).toBe(true)
  })
  it('rejects a forged embedded key even when its signature is valid', async () => {
    const { record, options } = await fixture()
    const kaworu = await Secp256k1Keypair.create()
    record.attestation.signingKey = kaworu.did()
    record.attestation.sig = await kaworu.sign(
      encode({
        did: userDid,
        signingKey: record.signingKey,
        boundaries: record.boundaries.map((b) => b.value),
        issuedAt,
      }),
    )
    expect(
      (await verifyEnrollmentAttestation(record, userDid, options)).valid,
    ).toBe(false)
  })
  it.each([
    '1995-10-05T00:00:00.000Z',
    '1995-10-03T23:59:59.999Z',
    'not-a-time',
  ])('rejects time outside the signing window %s', async (time) => {
    const { record, shinji, options } = await fixture()
    record.attestation.issuedAt = time
    record.attestation.sig = await shinji.sign(
      encode({
        did: userDid,
        signingKey: record.signingKey,
        boundaries: record.boundaries.map((b) => b.value),
        issuedAt: time,
      }),
    )
    expect(
      (await verifyEnrollmentAttestation(record, userDid, options)).valid,
    ).toBe(false)
  })
  it('rejects changing an authenticated time even inside its authorized window', async () => {
    const { record, options } = await fixture()
    record.attestation.issuedAt = '1995-10-04T13:00:00.000Z'
    expect(
      (await verifyEnrollmentAttestation(record, userDid, options)).valid,
    ).toBe(false)
  })
  it('freshly resolves the anchor despite a cached retired key', async () => {
    const { record, doc, options, rei } = await fixture()
    const cache = new Map()
    const saved = doc.verificationMethod[0].publicKeyMultibase
    doc.verificationMethod[0].publicKeyMultibase =
      record.attestation.signingKey.slice(8)
    await resolveServiceSigningKey(did, { ...options, cache })
    doc.verificationMethod[0].publicKeyMultibase = saved
    expect(
      (
        await verifyEnrollmentAttestation(record, userDid, {
          ...options,
          cache,
        })
      ).valid,
    ).toBe(true)
    expect(await cache.get(did).exportPublicKey('did')).toBe(rei.did())
  })
  it.each(['http://nerv.example', 'https://user:password@nerv.example'])(
    'rejects unsafe history endpoint %s',
    async (endpoint) => {
      const { record, doc, options } = await fixture()
      doc.service[0].serviceEndpoint = endpoint
      expect(
        (await verifyEnrollmentAttestation(record, userDid, options)).error,
      ).toContain('HTTPS endpoint')
    },
  )
  it('requires a typed, DID-controlled endpoint', async () => {
    const { record, doc, options } = await fixture()
    doc.service = []
    expect(
      (await verifyEnrollmentAttestation(record, userDid, options)).error,
    ).toContain('Stratos service endpoint')
  })
  it('accepts the fully qualified service fragment and removes URL query and hash', async () => {
    const { record, doc, options, fetchFn } = await fixture()
    doc.service[0].id = `${did}#stratos`
    doc.service[0].serviceEndpoint =
      'https://nerv.example/service/?secret=omit#omit'
    expect(
      (await verifyEnrollmentAttestation(record, userDid, options)).valid,
    ).toBe(true)
    expect(fetchFn.mock.calls[1][0]).toBe(
      'https://nerv.example/service/xrpc/zone.stratos.identity.getKeyHistory',
    )
  })
  it.each([
    new Response(null, { status: 503 }),
    new Response(null),
    new Response('x'.repeat(2_000_001)),
  ])(
    'fails closed for unavailable or oversized responses',
    async (response) => {
      const { record, options, fetchFn, doc } = await fixture()
      fetchFn.mockImplementation(async (url) =>
        String(url).includes('getKeyHistory') ? response : Response.json(doc),
      )
      expect(
        (await verifyEnrollmentAttestation(record, userDid, options)).valid,
      ).toBe(false)
    },
  )
})

it('rejects malformed and invalid current-key timestamps explicitly', async () => {
  const { record, doc, shinji, options } = await fixture()
  doc.verificationMethod[0].publicKeyMultibase = shinji.did().slice(8)
  const malformed = {
    ...record,
    attestation: { ...record.attestation, issuedAt: 42 },
  }
  expect(
    (await verifyEnrollmentAttestation(malformed, userDid, options)).error,
  ).toBe('Record missing attestation or signingKey fields')
  record.attestation.issuedAt = 'invalid'
  record.attestation.sig = await shinji.sign(
    encode({
      did: userDid,
      signingKey: record.signingKey,
      boundaries: record.boundaries.map((b) => b.value),
      issuedAt: 'invalid',
    }),
  )
  expect(
    (await verifyEnrollmentAttestation(record, userDid, options)).error,
  ).toBe('Key history requires canonical UTC timestamps')
})

it('resolves without options and ignores unrelated DID services', async () => {
  const { record, doc, options, fetchFn } = await fixture()
  vi.stubGlobal('fetch', fetchFn)
  try {
    expect(await resolveServiceSigningKey(did)).toBeDefined()
  } finally {
    vi.unstubAllGlobals()
  }
  doc.service.unshift({
    id: '#other',
    type: 'StratosService',
    serviceEndpoint: 'https://seele.example',
  })
  expect(
    (await verifyEnrollmentAttestation(record, userDid, options)).valid,
  ).toBe(true)
  expect(fetchFn.mock.calls.at(-1)?.[0]).toBe(
    'https://nerv.example/xrpc/zone.stratos.identity.getKeyHistory',
  )
  doc.service = [
    { id: '#stratos', type: 'Other', serviceEndpoint: 'https://seele.example' },
  ]
  expect(
    (await verifyEnrollmentAttestation(record, userDid, options)).error,
  ).toBe('DID document has no Stratos service endpoint')
  delete (doc as { service?: unknown }).service
  expect(
    (await verifyEnrollmentAttestation(record, userDid, options)).error,
  ).toBe('DID document has no Stratos service endpoint')
})

it('returns a usable P256 historical key', async () => {
  const { rei, history, options, doc } = await fixture()
  const asuka = await Secp256k1Keypair.create()
  const rotated = await appendServiceKeyHistory(
    history,
    rei,
    asuka,
    '1995-10-06T00:00:00.000Z',
  )
  history.entries = rotated.entries
  doc.verificationMethod[0].publicKeyMultibase = asuka.did().slice(8)
  const key = await resolveServiceSigningKey(did, {
    ...options,
    attestation: {
      signingKey: rei.did(),
      issuedAt: '1995-10-05T00:00:00.000Z',
    },
  })
  expect(await key.exportPublicKey('did')).toBe(rei.did())
})

it('reports missing and failed response bodies with their original errors', async () => {
  const { record, options, fetchFn, doc, history } = await fixture()
  for (const [response, error] of [
    [
      Response.json(history, { status: 503 }),
      'Failed to fetch service key history',
    ],
    [new Response(null), 'Missing service key history response'],
  ] as const) {
    fetchFn.mockImplementation(async (url) =>
      String(url).includes('getKeyHistory') ? response : Response.json(doc),
    )
    expect(
      (await verifyEnrollmentAttestation(record, userDid, options)).error,
    ).toBe(error)
  }
})

it('reads chunked responses up to the byte limit and cancels oversized streams', async () => {
  const { record, options, fetchFn, doc, history } = await fixture()
  const json = JSON.stringify(history)
  const bytes = new TextEncoder().encode(
    json + ' '.repeat(2_000_000 - json.length),
  )
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 37))
      controller.enqueue(bytes.slice(37))
      controller.close()
    },
  })
  fetchFn.mockImplementation(async (url) =>
    String(url).includes('getKeyHistory')
      ? new Response(stream)
      : Response.json(doc),
  )
  expect(
    (await verifyEnrollmentAttestation(record, userDid, options)).valid,
  ).toBe(true)
  const cancel = vi.fn()
  const oversized = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2_000_001))
    },
    cancel,
  })
  fetchFn.mockImplementation(async (url) =>
    String(url).includes('getKeyHistory')
      ? new Response(oversized)
      : Response.json(doc),
  )
  expect(
    (await verifyEnrollmentAttestation(record, userDid, options)).error,
  ).toBe('Service key history response is too large')
  expect(cancel).toHaveBeenCalledOnce()
})

it('preserves UTF-8 characters split across response chunks', async () => {
  const value = { message: '綾波レイ' }
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const firstCharacter = bytes.findIndex((byte) => byte > 127)
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, firstCharacter + 1))
      controller.enqueue(bytes.slice(firstCharacter + 1))
      controller.close()
    },
  })
  expect(await readKeyHistoryResponse(new Response(stream))).toEqual(value)
})
