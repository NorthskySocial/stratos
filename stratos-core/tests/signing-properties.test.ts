import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import {
  encode as cborEncode,
  decode as cborDecode,
  toBytes as cborToBytes,
} from '@atcute/cbor'
import { createAttestationPayload } from '../src/index.js'

describe('Signing and Attestation Property-Based Tests', () => {
  it('should create consistent attestation payloads', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }), // DID
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 10 }), // boundaries
        fc.string({ minLength: 1 }), // signingKey
        (did, boundaries, signingKey) => {
          const payload1 = createAttestationPayload(did, boundaries, signingKey)
          const payload2 = createAttestationPayload(
            did,
            [...boundaries].reverse(),
            signingKey,
          )

          // Payload should be deterministic and order of boundaries shouldn't matter (they get sorted)
          expect(payload1).toEqual(payload2)

          const decoded = cborDecode(payload1) as any
          expect(decoded.did).toBe(did)
          expect(decoded.signingKey).toBe(signingKey)
          expect(decoded.boundaries).toEqual([...boundaries].sort())
        },
      ),
    )
  })

  it('should always sort boundaries in attestation payload', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 }), { minLength: 2, maxLength: 20 }),
        (boundaries) => {
          const payload = createAttestationPayload(
            'did:example:123',
            boundaries,
            'key',
          )
          const decoded = cborDecode(payload) as any
          const sortedBoundaries = [...decoded.boundaries]

          for (let i = 0; i < sortedBoundaries.length - 1; i++) {
            expect(sortedBoundaries[i] <= sortedBoundaries[i + 1]).toBe(true)
          }
        },
      ),
    )
  })
})
