import { describe, expect, it, vi } from 'vitest'
import { P256Keypair, Secp256k1Keypair } from '@atproto/crypto'
import { encode as cborEncode, toBytes as cborToBytes } from '@atcute/cbor'
import type { CidLink } from '@atcute/cid'
import {
  create as cidCreate,
  fromString as cidFromString,
  toString as cidToString,
} from '@atcute/cid'
import {
  buildInclusionProof,
  MemoryBlockStore,
  NodeStore,
  OverlayBlockStore,
} from '@atcute/mst'
import { P256PublicKey, parseDidKey, Secp256k1PublicKey } from '@atcute/crypto'
import { buildCommit } from '@northskysocial/stratos-core'
import { collectCarStream } from '@northskysocial/stratos-core/tests'

import {
  fetchAndVerifyRecord,
  resolveServiceSigningKey,
  resolveUserSigningKey,
  verifyCidIntegrity,
} from '../src/index.js'

const TEST_DID = 'did:plc:testverify' as const
const TEST_COLLECTION = 'zone.stratos.feed.post'
const TEST_RKEY = 'abc123'

async function buildSignedRecordCar(
  keypair: Secp256k1Keypair,
  did: string,
  collection: string,
  rkey: string,
): Promise<{ carBytes: Uint8Array; recordCid: string }> {
  const recordData = cborEncode({
    text: 'test record',
    createdAt: '2025-01-01T00:00:00Z',
  })
  const recordAtcuteCid = await cidCreate(0x71, recordData)
  const recordCidStr = cidToString(recordAtcuteCid)

  const storage = new MemoryBlockStore()

  const unsigned = await buildCommit(storage, null, {
    did,
    writes: [{ action: 'create', collection, rkey, cid: recordCidStr }],
  })

  const unsignedCommit = {
    did: unsigned.did,
    version: unsigned.version as 3,
    data: { $link: unsigned.data } as CidLink,
    rev: unsigned.rev,
    prev: null,
  }

  const unsignedBytes = cborEncode(unsignedCommit)
  const sig = await keypair.sign(unsignedBytes)

  const signedCommit = {
    ...unsignedCommit,
    sig: cborToBytes(sig),
  }

  const commitBytes = cborEncode(signedCommit)
  const commitCid = await cidCreate(0x71, commitBytes)
  const commitCidStr = cidToString(commitCid)

  const newBlockStore = new MemoryBlockStore(unsigned.newBlocks)
  const overlay = new OverlayBlockStore(newBlockStore, storage)
  const nodeStore = new NodeStore(overlay)

  const proofCids = await buildInclusionProof(
    nodeStore,
    unsigned.data,
    `${collection}/${rkey}`,
  )

  const blockMap = new Map<string, Uint8Array>()
  blockMap.set(commitCidStr, commitBytes)

  for (const [cidStr, bytes] of unsigned.newBlocks) {
    blockMap.set(cidStr, bytes)
  }

  for (const proofCidStr of proofCids) {
    if (!blockMap.has(proofCidStr)) {
      const bytes = await overlay.get(proofCidStr)
      if (bytes) blockMap.set(proofCidStr, bytes)
    }
  }

  blockMap.set(recordCidStr, recordData)

  const carBlocks: Array<{ cid: Uint8Array; data: Uint8Array }> = []
  for (const [cidStr, bytes] of blockMap) {
    carBlocks.push({ cid: cidFromString(cidStr).bytes, data: bytes })
  }

  const carBytes = await collectCarStream([{ $link: commitCidStr }], carBlocks)

  return { carBytes, recordCid: recordCidStr }
}

async function keypairToPublicKey(keypair: Secp256k1Keypair) {
  const didKey = keypair.did()
  const found = parseDidKey(didKey)
  return Secp256k1PublicKey.importRaw(found.publicKeyBytes)
}

async function p256KeypairToPublicKey(keypair: P256Keypair) {
  const didKey = keypair.did()
  const found = parseDidKey(didKey)
  return P256PublicKey.importRaw(found.publicKeyBytes)
}

async function buildP256SignedRecordCar(
  keypair: P256Keypair,
  did: string,
  collection: string,
  rkey: string,
): Promise<{ carBytes: Uint8Array; recordCid: string }> {
  return buildSignedRecordCar(
    keypair as unknown as Secp256k1Keypair,
    did,
    collection,
    rkey,
  )
}

describe('verifyCidIntegrity', () => {
  it('succeeds on a valid CAR without checking signature', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const { carBytes } = await buildSignedRecordCar(
      keypair,
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
    )

    const result = await verifyCidIntegrity(
      carBytes,
      TEST_COLLECTION,
      TEST_RKEY,
      TEST_DID,
    )

    expect(result.level).toBe('cid-integrity')
    expect(result.cid).toBeTruthy()
    expect(result.record).toBeTruthy()
  })

  it('succeeds without DID check when did is omitted', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const { carBytes } = await buildSignedRecordCar(
      keypair,
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
    )

    const result = await verifyCidIntegrity(
      carBytes,
      TEST_COLLECTION,
      TEST_RKEY,
    )

    expect(result.level).toBe('cid-integrity')
    expect(result.cid).toBeTruthy()
  })

  it('fails on corrupted CAR bytes', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const { carBytes } = await buildSignedRecordCar(
      keypair,
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
    )

    const corrupted = new Uint8Array(carBytes)
    corrupted[corrupted.length - 10] ^= 0xff

    await expect(
      verifyCidIntegrity(corrupted, TEST_COLLECTION, TEST_RKEY, TEST_DID),
    ).rejects.toThrow()
  })

  it('fails when DID does not match commit', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const { carBytes } = await buildSignedRecordCar(
      keypair,
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
    )

    await expect(
      verifyCidIntegrity(
        carBytes,
        TEST_COLLECTION,
        TEST_RKEY,
        'did:plc:wrongdid',
      ),
    ).rejects.toThrow(/did/)
  })
})

describe('fetchAndVerifyRecord', () => {
  it('extracts a secp256k1 key from a DID document via #atproto fragment', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const didKey = keypair.did()
    const publicKeyMultibase = didKey.slice('did:key:'.length)

    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            '@context': [
              'https://www.w3.org/ns/did/v1',
              'https://w3id.org/security/multikey/v1',
            ],
            id: 'did:web:stratos.example.com',
            verificationMethod: [
              {
                id: 'did:web:stratos.example.com#atproto',
                type: 'Multikey',
                controller: 'did:web:stratos.example.com',
                publicKeyMultibase,
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    )

    const key = await resolveServiceSigningKey('did:web:stratos.example.com', {
      fetchFn: mockFetch,
    })

    expect(key).toBeTruthy()
    expect(key.type).toBe('secp256k1')
    expect(mockFetch).toHaveBeenCalled()
  })

  it('throws for non-did:web identifiers', async () => {
    await expect(resolveServiceSigningKey('did:plc:abc123')).rejects.toThrow(
      /did:web/,
    )
  })

  it('throws when DID document has no #atproto verificationMethod', async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            '@context': ['https://www.w3.org/ns/did/v1'],
            id: 'did:web:stratos.example.com',
            service: [
              {
                id: '#stratos',
                type: 'StratosService',
                serviceEndpoint: 'https://stratos.example.com',
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    )

    await expect(
      resolveServiceSigningKey('did:web:stratos.example.com', {
        fetchFn: mockFetch,
      }),
    ).rejects.toThrow(/#atproto verificationMethod/)
  })

  it('ignores verificationMethods without #atproto fragment', async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            '@context': ['https://www.w3.org/ns/did/v1'],
            id: 'did:web:stratos.example.com',
            verificationMethod: [
              {
                id: 'did:web:stratos.example.com#other-key',
                type: 'Multikey',
                controller: 'did:web:stratos.example.com',
                publicKeyMultibase:
                  'zQ3shqwJEJyMBsBXCWyCBpUBMqxcon9oHB7mCvx4sSpMdLJwc',
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    )

    await expect(
      resolveServiceSigningKey('did:web:stratos.example.com', {
        fetchFn: mockFetch,
      }),
    ).rejects.toThrow(/#atproto verificationMethod/)
  })
})

describe('fetchAndVerifyRecord', () => {
  it('uses service signature verification when serviceSigningKey is provided', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const publicKey = await keypairToPublicKey(keypair)
    const { carBytes } = await buildSignedRecordCar(
      keypair,
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
    )

    const mockFetch = vi.fn(async () => new Response(carBytes))

    const result = await fetchAndVerifyRecord(
      'https://stratos.example.com',
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
      { serviceSigningKey: publicKey, fetchFn: mockFetch },
    )

    expect(result.level).toBe('service-signature')
    expect(result.cid).toBeTruthy()
  })

  it('fails with wrong keypair', async () => {
    const signingKeypair = await Secp256k1Keypair.create({ exportable: true })
    const wrongKeypair = await Secp256k1Keypair.create({ exportable: true })
    const wrongPublicKey = await keypairToPublicKey(wrongKeypair)
    const { carBytes } = await buildSignedRecordCar(
      signingKeypair,
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
    )

    const mockFetch = vi.fn(async () => new Response(carBytes))

    await expect(
      fetchAndVerifyRecord(
        'https://stratos.example.com',
        TEST_DID,
        TEST_COLLECTION,
        TEST_RKEY,
        { serviceSigningKey: wrongPublicKey, fetchFn: mockFetch },
      ),
    ).rejects.toThrow(/signature/)
  })

  it('fails with wrong DID (cross-user swap detection)', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const publicKey = await keypairToPublicKey(keypair)
    const { carBytes } = await buildSignedRecordCar(
      keypair,
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
    )

    const mockFetch = vi.fn(async () => new Response(carBytes))

    await expect(
      fetchAndVerifyRecord(
        'https://stratos.example.com',
        'did:plc:differentuser',
        TEST_COLLECTION,
        TEST_RKEY,
        { serviceSigningKey: publicKey, fetchFn: mockFetch },
      ),
    ).rejects.toThrow(/did/)
  })

  it('falls back to CID integrity when no serviceSigningKey is provided', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const { carBytes } = await buildSignedRecordCar(
      keypair,
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
    )

    const mockFetch = vi.fn(async () => new Response(carBytes))

    const result = await fetchAndVerifyRecord(
      'https://stratos.example.com',
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
      { fetchFn: mockFetch },
    )

    expect(result.level).toBe('cid-integrity')
    expect(result.cid).toBeTruthy()
  })

  it('constructs the correct XRPC URL', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const { carBytes } = await buildSignedRecordCar(
      keypair,
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
    )

    const mockFetch = vi.fn<typeof fetch>(async () => new Response(carBytes))

    await fetchAndVerifyRecord(
      'https://stratos.example.com',
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
      { fetchFn: mockFetch },
    )

    const calledUrl = mockFetch.mock.calls[0][0] as string
    expect(calledUrl).toContain('com.atproto.sync.getRecord')
    expect(calledUrl).toContain(encodeURIComponent(TEST_DID))
    expect(calledUrl).toContain(encodeURIComponent(TEST_COLLECTION))
    expect(calledUrl).toContain(TEST_RKEY)
  })

  it('throws on non-OK response', async () => {
    const mockFetch = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 404, statusText: 'Not Found' }),
    )

    await expect(
      fetchAndVerifyRecord(
        'https://stratos.example.com',
        TEST_DID,
        TEST_COLLECTION,
        TEST_RKEY,
        { fetchFn: mockFetch },
      ),
    ).rejects.toThrow(/404/)
  })

  it('end-to-end: resolveServiceSigningKey + fetchAndVerifyRecord', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const didKey = keypair.did()
    const publicKeyMultibase = didKey.slice('did:key:'.length)
    const { carBytes } = await buildSignedRecordCar(
      keypair,
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
    )

    const didDocFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            '@context': [
              'https://www.w3.org/ns/did/v1',
              'https://w3id.org/security/multikey/v1',
            ],
            id: 'did:web:stratos.example.com',
            verificationMethod: [
              {
                id: 'did:web:stratos.example.com#atproto',
                type: 'Multikey',
                controller: 'did:web:stratos.example.com',
                publicKeyMultibase,
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    )

    const serviceSigningKey = await resolveServiceSigningKey(
      'did:web:stratos.example.com',
      { fetchFn: didDocFetch },
    )

    const recordFetch = vi.fn<typeof fetch>(async () => new Response(carBytes))

    const result = await fetchAndVerifyRecord(
      'https://stratos.example.com',
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
      { serviceSigningKey, fetchFn: recordFetch },
    )

    expect(result.level).toBe('service-signature')
    expect(result.cid).toBeTruthy()
    expect(result.record).toEqual({
      text: 'test record',
      createdAt: '2025-01-01T00:00:00Z',
    })
  })
})

describe('user-signature verification', () => {
  it('verifies a P256-signed commit as user-signature level', async () => {
    const keypair = await P256Keypair.create({ exportable: true })
    const publicKey = await p256KeypairToPublicKey(keypair)
    const { carBytes } = await buildP256SignedRecordCar(
      keypair,
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
    )

    const mockFetch = vi.fn<typeof fetch>(async () => new Response(carBytes))

    const result = await fetchAndVerifyRecord(
      'https://stratos.example.com',
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
      { userSigningKey: publicKey, fetchFn: mockFetch },
    )

    expect(result.level).toBe('user-signature')
    expect(result.cid).toBeTruthy()
    expect(result.record).toEqual({
      text: 'test record',
      createdAt: '2025-01-01T00:00:00Z',
    })
  })

  it('fails with wrong P256 key', async () => {
    const signingKeypair = await P256Keypair.create({ exportable: true })
    const wrongKeypair = await P256Keypair.create({ exportable: true })
    const wrongPublicKey = await p256KeypairToPublicKey(wrongKeypair)
    const { carBytes } = await buildP256SignedRecordCar(
      signingKeypair,
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
    )

    const mockFetch = vi.fn(async () => new Response(carBytes))

    await expect(
      fetchAndVerifyRecord(
        'https://stratos.example.com',
        TEST_DID,
        TEST_COLLECTION,
        TEST_RKEY,
        { userSigningKey: wrongPublicKey, fetchFn: mockFetch },
      ),
    ).rejects.toThrow(/signature/)
  })

  it('prefers userSigningKey over serviceSigningKey when both provided', async () => {
    const userKeypair = await P256Keypair.create({ exportable: true })
    const userPublicKey = await p256KeypairToPublicKey(userKeypair)
    const serviceKeypair = await Secp256k1Keypair.create({ exportable: true })
    const servicePublicKey = await keypairToPublicKey(serviceKeypair)

    const { carBytes } = await buildP256SignedRecordCar(
      userKeypair,
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
    )

    const mockFetch = vi.fn(async () => new Response(carBytes))

    const result = await fetchAndVerifyRecord(
      'https://stratos.example.com',
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
      {
        userSigningKey: userPublicKey,
        serviceSigningKey: servicePublicKey,
        fetchFn: mockFetch,
      },
    )

    expect(result.level).toBe('user-signature')
  })

  it('falls back to service-signature when only serviceSigningKey provided', async () => {
    const serviceKeypair = await Secp256k1Keypair.create({ exportable: true })
    const servicePublicKey = await keypairToPublicKey(serviceKeypair)
    const { carBytes } = await buildSignedRecordCar(
      serviceKeypair,
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
    )

    const mockFetch = vi.fn(async () => new Response(carBytes))

    const result = await fetchAndVerifyRecord(
      'https://stratos.example.com',
      TEST_DID,
      TEST_COLLECTION,
      TEST_RKEY,
      { serviceSigningKey: servicePublicKey, fetchFn: mockFetch },
    )

    expect(result.level).toBe('service-signature')
  })
})

describe('resolveUserSigningKey', () => {
  it('resolves a P256 signing key from enrollment record', async () => {
    const keypair = await P256Keypair.create({ exportable: true })
    const didKey = keypair.did()

    const sigBytes = new Uint8Array([0xde, 0xad])
    const sigB64 = btoa(String.fromCharCode(...sigBytes))

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          records: [
            {
              uri: 'at://did:plc:testuser/zone.stratos.actor.enrollment/did:web:stratos.example.com',
              cid: 'bafytest',
              value: {
                service: 'https://stratos.example.com',
                boundaries: [{ value: 'did:web:nerv.tokyo.jp/engineering' }],
                signingKey: didKey,
                attestation: {
                  sig: { $bytes: sigB64 },
                  signingKey: 'did:key:zServiceKey',
                },
                createdAt: '2025-01-01T00:00:00Z',
              },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    )

    const publicKey = await resolveUserSigningKey(
      'https://pds.example.com',
      'did:plc:testuser',
      'did:web:stratos.example.com',
    )

    expect(publicKey).toBeTruthy()
    expect(publicKey!.type).toBe('p256')

    vi.restoreAllMocks()
  })

  it('returns null when no enrollment exists for the service', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ records: [] }), {
        headers: { 'content-type': 'application/json' },
      }),
    )

    const publicKey = await resolveUserSigningKey(
      'https://pds.example.com',
      'did:plc:testuser',
      'did:web:stratos.example.com',
    )

    expect(publicKey).toBeNull()

    vi.restoreAllMocks()
  })

  it('returns null when enrollment for a different service exists', async () => {
    const keypair = await P256Keypair.create({ exportable: true })
    const sigBytes = new Uint8Array([0xca, 0xfe])
    const sigB64 = btoa(String.fromCharCode(...sigBytes))

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          records: [
            {
              uri: 'at://did:plc:testuser/zone.stratos.actor.enrollment/did:web:other-service.example.com',
              cid: 'bafytest',
              value: {
                service: 'https://other-service.example.com',
                boundaries: [],
                signingKey: keypair.did(),
                attestation: {
                  sig: { $bytes: sigB64 },
                  signingKey: 'did:key:zServiceKey',
                },
                createdAt: '2025-01-01T00:00:00Z',
              },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    )

    const publicKey = await resolveUserSigningKey(
      'https://pds.example.com',
      'did:plc:testuser',
      'did:web:stratos.example.com',
    )

    expect(publicKey).toBeNull()

    vi.restoreAllMocks()
  })
})
