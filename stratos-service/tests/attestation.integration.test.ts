/**
 * Integration tests for attestation creation and verification.
 *
 * Tests the full flow: service generates a signing keypair, creates
 * attestation payloads via stratos-core, signs them, and the resulting
 * attestation can be verified using @atproto/crypto — exactly as an
 * AppView or client would verify an enrollment record.
 */
import { describe, expect, it } from 'vitest'
import { Secp256k1Keypair, verifySignature } from '@atproto/crypto'
import { decode as cborDecode, encode as cborEncode } from '@atcute/cbor'
import {
  type Attestation,
  createAttestationPayload,
} from '@northskysocial/stratos-core'

const TEST_DID = 'did:plc:testattestation'

async function createServiceKeypair() {
  return Secp256k1Keypair.create({ exportable: true })
}

async function createAttestation(
  serviceKeypair: Secp256k1Keypair,
  did: string,
  boundaries: string[],
  userSigningKey: string,
): Promise<Attestation> {
  const payload = createAttestationPayload(did, boundaries, userSigningKey)
  const sig = await serviceKeypair.sign(payload)
  return { sig, signingKey: serviceKeypair.did() }
}

describe('Attestation Integration', () => {
  describe('create and verify attestation', () => {
    it('round-trips: create attestation → verify with service public key', async () => {
      const serviceKeypair = await createServiceKeypair()
      const userSigningKey = 'did:key:zDnaeUserKey123'
      const boundaries = [
        'did:web:nerv.tokyo.jp/engineering',
        'did:web:nerv.tokyo.jp/leadership',
      ]

      const attestation = await createAttestation(
        serviceKeypair,
        TEST_DID,
        boundaries,
        userSigningKey,
      )

      const payload = createAttestationPayload(
        TEST_DID,
        boundaries,
        userSigningKey,
      )
      const valid = await verifySignature(
        attestation.signingKey,
        payload,
        attestation.sig,
      )

      expect(valid).toBe(true)
    })

    it('verification succeeds regardless of boundary input order', async () => {
      const serviceKeypair = await createServiceKeypair()
      const userSigningKey = 'did:key:zDnaeUserKey456'

      const attestation = await createAttestation(
        serviceKeypair,
        TEST_DID,
        [
          'did:web:nerv.tokyo.jp/zebra',
          'did:web:nerv.tokyo.jp/alpha',
          'did:web:nerv.tokyo.jp/middle',
        ],
        userSigningKey,
      )

      // Verifier reconstructs payload with different input order
      const payload = createAttestationPayload(
        TEST_DID,
        [
          'did:web:nerv.tokyo.jp/middle',
          'did:web:nerv.tokyo.jp/zebra',
          'did:web:nerv.tokyo.jp/alpha',
        ],
        userSigningKey,
      )
      const valid = await verifySignature(
        attestation.signingKey,
        payload,
        attestation.sig,
      )

      expect(valid).toBe(true)
    })

    it('verification fails with a different service key', async () => {
      const serviceKeypair = await createServiceKeypair()
      const wrongKeypair = await createServiceKeypair()
      const userSigningKey = 'did:key:zDnaeUserKey789'
      const boundaries = ['did:web:nerv.tokyo.jp/engineering']

      const attestation = await createAttestation(
        serviceKeypair,
        TEST_DID,
        boundaries,
        userSigningKey,
      )

      const payload = createAttestationPayload(
        TEST_DID,
        boundaries,
        userSigningKey,
      )

      // Verify against the wrong key — must fail
      const valid = await verifySignature(
        wrongKeypair.did(),
        payload,
        attestation.sig,
      )

      expect(valid).toBe(false)
    })

    it('verification fails when payload DID is tampered', async () => {
      const serviceKeypair = await createServiceKeypair()
      const userSigningKey = 'did:key:zDnaeUserKey000'
      const boundaries = ['did:web:nerv.tokyo.jp/engineering']

      const attestation = await createAttestation(
        serviceKeypair,
        TEST_DID,
        boundaries,
        userSigningKey,
      )

      // Reconstruct payload with a different DID
      const tamperedPayload = createAttestationPayload(
        'did:plc:impersonator',
        boundaries,
        userSigningKey,
      )

      const valid = await verifySignature(
        attestation.signingKey,
        tamperedPayload,
        attestation.sig,
      )

      expect(valid).toBe(false)
    })

    it('verification fails when boundaries are tampered', async () => {
      const serviceKeypair = await createServiceKeypair()
      const userSigningKey = 'did:key:zDnaeUserKeyABC'
      const boundaries = ['did:web:nerv.tokyo.jp/engineering']

      const attestation = await createAttestation(
        serviceKeypair,
        TEST_DID,
        boundaries,
        userSigningKey,
      )

      const tamperedPayload = createAttestationPayload(
        TEST_DID,
        [
          'did:web:nerv.tokyo.jp/engineering',
          'did:web:nerv.tokyo.jp/leadership',
        ],
        userSigningKey,
      )

      const valid = await verifySignature(
        attestation.signingKey,
        tamperedPayload,
        attestation.sig,
      )

      expect(valid).toBe(false)
    })

    it('verification fails when user signing key is tampered', async () => {
      const serviceKeypair = await createServiceKeypair()
      const userSigningKey = 'did:key:zDnaeRealKey'
      const boundaries = ['did:web:nerv.tokyo.jp/alpha']

      const attestation = await createAttestation(
        serviceKeypair,
        TEST_DID,
        boundaries,
        userSigningKey,
      )

      const tamperedPayload = createAttestationPayload(
        TEST_DID,
        boundaries,
        'did:key:zDnaeFakeKey',
      )

      const valid = await verifySignature(
        attestation.signingKey,
        tamperedPayload,
        attestation.sig,
      )

      expect(valid).toBe(false)
    })
  })

  describe('attestation payload determinism', () => {
    it('same inputs from create and verify sides produce identical bytes', async () => {
      const did = 'did:plc:canonical'
      const boundaries = [
        'did:web:nerv.tokyo.jp/beta',
        'did:web:nerv.tokyo.jp/alpha',
      ]
      const userKey = 'did:key:zDnaeCanonical'

      const fromCreator = createAttestationPayload(did, boundaries, userKey)
      const fromVerifier = createAttestationPayload(did, boundaries, userKey)

      expect(fromCreator).toEqual(fromVerifier)
    })

    it('payload CBOR contains the expected fields', async () => {
      const did = 'did:plc:inspect'
      const boundaries = [
        'did:web:nerv.tokyo.jp/gamma',
        'did:web:nerv.tokyo.jp/alpha',
        'did:web:nerv.tokyo.jp/beta',
      ]
      const userKey = 'did:key:zDnaeInspect'

      const payload = createAttestationPayload(did, boundaries, userKey)
      const decoded = cborDecode(payload) as {
        boundaries: string[]
        did: string
        signingKey: string
      }

      expect(decoded.did).toBe(did)
      expect(decoded.signingKey).toBe(userKey)
      expect(decoded.boundaries).toEqual([
        'did:web:nerv.tokyo.jp/alpha',
        'did:web:nerv.tokyo.jp/beta',
        'did:web:nerv.tokyo.jp/gamma',
      ])
    })
  })

  describe('client-style verification', () => {
    it('verifies attestation the way an AppView would from an enrollment record', async () => {
      const serviceKeypair = await createServiceKeypair()
      const userSigningKey = 'did:key:zDnaeAppViewTest'
      const boundaries = [
        'did:web:nerv.tokyo.jp/engineering',
        'did:web:nerv.tokyo.jp/product',
      ]

      // --- Service side: create enrollment attestation ---
      const attestation = await createAttestation(
        serviceKeypair,
        TEST_DID,
        boundaries,
        userSigningKey,
      )

      // --- Simulate enrollment record as stored on PDS ---
      const enrollmentRecord = {
        service: 'https://stratos.example.com',
        boundaries: boundaries.map((b) => ({ value: b })),
        signingKey: userSigningKey,
        attestation: {
          sig: attestation.sig,
          signingKey: attestation.signingKey,
        },
        createdAt: new Date().toISOString(),
      }

      // --- Client side: verify attestation ---
      const sortedBoundaries = enrollmentRecord.boundaries
        .map((b) => b.value)
        .sort()

      const verifyPayload = cborEncode({
        boundaries: sortedBoundaries,
        did: TEST_DID,
        signingKey: enrollmentRecord.signingKey,
      })

      const valid = await verifySignature(
        enrollmentRecord.attestation.signingKey,
        verifyPayload,
        enrollmentRecord.attestation.sig,
      )

      expect(valid).toBe(true)
    })

    it('rejects attestation when enrollment record boundaries are modified after creation', async () => {
      const serviceKeypair = await createServiceKeypair()
      const userSigningKey = 'did:key:zDnaeTamperTest'
      const originalBoundaries = ['did:web:nerv.tokyo.jp/engineering']

      const attestation = await createAttestation(
        serviceKeypair,
        TEST_DID,
        originalBoundaries,
        userSigningKey,
      )

      // Simulate a tampered enrollment record where someone added a boundary
      const tamperedRecord = {
        boundaries: [
          { value: 'did:web:nerv.tokyo.jp/engineering' },
          { value: 'did:web:nerv.tokyo.jp/admin' },
        ],
        signingKey: userSigningKey,
        attestation: {
          sig: attestation.sig,
          signingKey: attestation.signingKey,
        },
      }

      const sortedBoundaries = tamperedRecord.boundaries
        .map((b) => b.value)
        .sort()

      const verifyPayload = cborEncode({
        boundaries: sortedBoundaries,
        did: TEST_DID,
        signingKey: tamperedRecord.signingKey,
      })

      const valid = await verifySignature(
        tamperedRecord.attestation.signingKey,
        verifyPayload,
        tamperedRecord.attestation.sig,
      )

      expect(valid).toBe(false)
    })
  })

  describe('multiple attestations with same service key', () => {
    it('produces distinct signatures for different users', async () => {
      const serviceKeypair = await createServiceKeypair()
      const userKey = 'did:key:zDnaeShared'
      const boundaries = ['did:web:nerv.tokyo.jp/engineering']

      const att1 = await createAttestation(
        serviceKeypair,
        'did:plc:user1',
        boundaries,
        userKey,
      )
      const att2 = await createAttestation(
        serviceKeypair,
        'did:plc:user2',
        boundaries,
        userKey,
      )

      expect(att1.sig).not.toEqual(att2.sig)

      // Both are independently valid
      const payload1 = createAttestationPayload(
        'did:plc:user1',
        boundaries,
        userKey,
      )
      const payload2 = createAttestationPayload(
        'did:plc:user2',
        boundaries,
        userKey,
      )

      expect(await verifySignature(att1.signingKey, payload1, att1.sig)).toBe(
        true,
      )
      expect(await verifySignature(att2.signingKey, payload2, att2.sig)).toBe(
        true,
      )
    })

    it('user1 attestation does not verify with user2 payload', async () => {
      const serviceKeypair = await createServiceKeypair()
      const userKey = 'did:key:zDnaeCross'
      const boundaries = ['did:web:nerv.tokyo.jp/alpha']

      const att1 = await createAttestation(
        serviceKeypair,
        'did:plc:user1',
        boundaries,
        userKey,
      )

      const payload2 = createAttestationPayload(
        'did:plc:user2',
        boundaries,
        userKey,
      )

      const valid = await verifySignature(att1.signingKey, payload2, att1.sig)
      expect(valid).toBe(false)
    })
  })

  describe('empty boundaries', () => {
    it('attestation with no boundaries can be created and verified', async () => {
      const serviceKeypair = await createServiceKeypair()
      const userKey = 'did:key:zDnaeNoBoundary'

      const attestation = await createAttestation(
        serviceKeypair,
        TEST_DID,
        [],
        userKey,
      )

      const payload = createAttestationPayload(TEST_DID, [], userKey)
      const valid = await verifySignature(
        attestation.signingKey,
        payload,
        attestation.sig,
      )

      expect(valid).toBe(true)
    })
  })
})
