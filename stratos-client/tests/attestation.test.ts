import { describe, expect, it } from 'vitest'
import { P256Keypair, Secp256k1Keypair } from '@atproto/crypto'
import { encode as cborEncode } from '@atcute/cbor'

import { verifyEnrollmentAttestation } from '../src/index.js'

const USER_DID = 'did:plc:shinjiikari'
const USER_SIGNING_KEY = 'did:key:zUserSigningKeyPlaceholder'
const SERVICE_URL = 'https://stratos.nerv.tokyo.jp'

const BOUNDARIES = [
  'did:web:nerv.tokyo.jp/engineering',
  'did:web:nerv.tokyo.jp/leadership',
]

type Keypair = Secp256k1Keypair | P256Keypair

/**
 * builds an enrollment record with a real service attestation over
 * {boundaries, did, signingKey}.
 */
const buildAttestedEnrollment = async (
  serviceKeypair: Keypair,
  options: {
    userDid?: string
    userSigningKey?: string
    boundaryValues?: Array<string>
    signedBoundaries?: Array<string>
  } = {},
) => {
  const userDid = options.userDid ?? USER_DID
  const userSigningKey = options.userSigningKey ?? USER_SIGNING_KEY
  const boundaryValues = options.boundaryValues ?? BOUNDARIES

  const payload = cborEncode({
    boundaries: [...(options.signedBoundaries ?? boundaryValues)].sort(),
    did: userDid,
    signingKey: userSigningKey,
  })

  const sig = await serviceKeypair.sign(payload)

  return {
    service: SERVICE_URL,
    boundaries: boundaryValues.map((value) => ({ value })),
    signingKey: userSigningKey,
    attestation: { sig, signingKey: serviceKeypair.did() },
    createdAt: '1995-10-04T00:00:00Z',
  }
}

const toBase64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...Array.from(bytes)))

describe('verifyEnrollmentAttestation', () => {
  it('accepts a valid secp256k1 attestation', async () => {
    const serviceKeypair = await Secp256k1Keypair.create({ exportable: true })
    const record = await buildAttestedEnrollment(serviceKeypair)

    const result = await verifyEnrollmentAttestation(record, USER_DID)

    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.serviceKey).toBe(serviceKeypair.did())
    expect(result.userSigningKey).toBe(USER_SIGNING_KEY)
    expect(result.boundaries).toEqual([...BOUNDARIES].sort())
  })

  it('accepts a valid p256 attestation', async () => {
    const serviceKeypair = await P256Keypair.create({ exportable: true })
    const record = await buildAttestedEnrollment(serviceKeypair)

    const result = await verifyEnrollmentAttestation(record, USER_DID)

    expect(result.valid).toBe(true)
  })

  it('accepts a signature in { $bytes } JSON interchange form', async () => {
    const serviceKeypair = await Secp256k1Keypair.create({ exportable: true })
    const record = await buildAttestedEnrollment(serviceKeypair)

    const jsonRecord = {
      ...record,
      attestation: {
        ...record.attestation,
        sig: { $bytes: toBase64(record.attestation.sig) },
      },
    }

    const result = await verifyEnrollmentAttestation(jsonRecord, USER_DID)

    expect(result.valid).toBe(true)
  })

  it('ignores the stored boundary order', async () => {
    const serviceKeypair = await Secp256k1Keypair.create({ exportable: true })
    const record = await buildAttestedEnrollment(serviceKeypair, {
      boundaryValues: [...BOUNDARIES].reverse(),
    })

    const result = await verifyEnrollmentAttestation(record, USER_DID)

    expect(result.valid).toBe(true)
    expect(result.boundaries).toEqual([...BOUNDARIES].sort())
  })

  it('rejects a record whose boundaries were tampered with', async () => {
    const serviceKeypair = await Secp256k1Keypair.create({ exportable: true })
    const record = await buildAttestedEnrollment(serviceKeypair, {
      signedBoundaries: BOUNDARIES,
      boundaryValues: [...BOUNDARIES, 'did:web:nerv.tokyo.jp/seele'],
    })

    const result = await verifyEnrollmentAttestation(record, USER_DID)

    expect(result.valid).toBe(false)
  })

  it('rejects a record attested for a different user', async () => {
    const serviceKeypair = await Secp256k1Keypair.create({ exportable: true })
    const record = await buildAttestedEnrollment(serviceKeypair)

    const result = await verifyEnrollmentAttestation(
      record,
      'did:plc:reiayanami',
    )

    expect(result.valid).toBe(false)
  })

  it('rejects a record whose signingKey was swapped', async () => {
    const serviceKeypair = await Secp256k1Keypair.create({ exportable: true })
    const record = await buildAttestedEnrollment(serviceKeypair)

    const tampered = { ...record, signingKey: 'did:key:zAttackerControlledKey' }

    const result = await verifyEnrollmentAttestation(tampered, USER_DID)

    expect(result.valid).toBe(false)
  })

  it('rejects a signature made by a different service key', async () => {
    const serviceKeypair = await Secp256k1Keypair.create({ exportable: true })
    const impostorKeypair = await Secp256k1Keypair.create({ exportable: true })
    const record = await buildAttestedEnrollment(serviceKeypair)

    const tampered = {
      ...record,
      attestation: {
        ...record.attestation,
        signingKey: impostorKeypair.did(),
      },
    }

    const result = await verifyEnrollmentAttestation(tampered, USER_DID)

    expect(result.valid).toBe(false)
  })

  it('reports a missing attestation field without throwing', async () => {
    const result = await verifyEnrollmentAttestation(
      {
        service: SERVICE_URL,
        boundaries: [],
        signingKey: USER_SIGNING_KEY,
        createdAt: '1995-10-04T00:00:00Z',
      },
      USER_DID,
    )

    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/missing attestation/i)
    expect(result.serviceKey).toBe('')
    expect(result.boundaries).toEqual([])
  })

  it('reports a missing signingKey field without throwing', async () => {
    const serviceKeypair = await Secp256k1Keypair.create({ exportable: true })
    const record = await buildAttestedEnrollment(serviceKeypair)
    const { signingKey: _removed, ...withoutSigningKey } = record

    const result = await verifyEnrollmentAttestation(
      withoutSigningKey,
      USER_DID,
    )

    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/missing attestation/i)
  })

  it('reports a malformed service did:key without throwing', async () => {
    const serviceKeypair = await Secp256k1Keypair.create({ exportable: true })
    const record = await buildAttestedEnrollment(serviceKeypair)

    const tampered = {
      ...record,
      attestation: { ...record.attestation, signingKey: 'not-a-did-key' },
    }

    const result = await verifyEnrollmentAttestation(tampered, USER_DID)

    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('returns a falsy result for a non-object record', async () => {
    const result = await verifyEnrollmentAttestation(null, USER_DID)

    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/missing attestation/i)
  })
})
