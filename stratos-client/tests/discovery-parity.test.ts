// stratos-client/src/discovery.ts is a deliberate fork of
// stratos-core/src/enrollment/discovery.ts: the client must never depend on
// core at runtime (core drags in drizzle-orm, postgres, and @libsql/client).
// Because the logic now lives in two places, a future change to the
// enrollment lexicon could get patched into one copy and not the other,
// and the indexer (which still imports core's copy) and the client would
// quietly disagree about what a valid enrollment is. This suite pins both
// implementations against each other and fails loudly the moment they
// diverge.
import { describe, expect, it } from 'vitest'
import {
  ENROLLMENT_COLLECTION as CORE_ENROLLMENT_COLLECTION,
  parseEnrollmentRecord as coreParseEnrollmentRecord,
  serviceDIDToRkey as coreServiceDIDToRkey,
} from '@northskysocial/stratos-core/enrollment'
import {
  ENROLLMENT_COLLECTION,
  parseEnrollmentRecord,
  serviceDIDToRkey,
} from '../src/index.js'

describe('discovery parity (client fork vs. core original)', () => {
  it('agrees on the enrollment collection NSID', () => {
    expect(ENROLLMENT_COLLECTION).toBe(CORE_ENROLLMENT_COLLECTION)
  })

  describe('serviceDIDToRkey', () => {
    it.each([
      'did:web:nerv.tokyo.jp',
      'did%3Aweb%3Anerv.tokyo.jp',
      'DID%3aWEB%3aNERV.TOKYO.JP',
      'did:plc:abc123',
    ])('agrees for input %j', (input) => {
      expect(serviceDIDToRkey(input)).toBe(coreServiceDIDToRkey(input))
    })
  })

  describe('parseEnrollmentRecord', () => {
    const validAttestation = {
      signingKey: 'did:key:zQ3shokFTS3LRDLqSbxDBZ5S4vS34C2Bv6N58K7Y72v4w4',
      sig: new Uint8Array([1, 2, 3]),
    }

    const validRecord = {
      service: 'did:web:nerv.tokyo.jp',
      createdAt: '1995-10-04T18:30:00Z',
      signingKey: 'did:key:zQ3shokFTS3LRDLqSbxDBZ5S4vS34C2Bv6N58K7Y72v4w4',
      boundaries: [{ value: 'geo:tokyo-3' }],
      attestation: validAttestation,
    }

    const cases: Array<[name: string, value: unknown]> = [
      ['valid record with boundaries', validRecord],
      [
        '$bytes-encoded attestation signature',
        {
          ...validRecord,
          attestation: { ...validAttestation, sig: { $bytes: 'AQID' } },
        },
      ],
      [
        'raw Uint8Array attestation signature',
        {
          ...validRecord,
          attestation: {
            ...validAttestation,
            sig: new Uint8Array([9, 8, 7]),
          },
        },
      ],
      [
        'missing boundaries',
        (() => {
          const record = { ...validRecord } as Record<string, unknown>
          delete record.boundaries
          return record
        })(),
      ],
      ['non-array boundaries', { ...validRecord, boundaries: 'not-an-array' }],
      ['null attestation', { ...validRecord, attestation: null }],
      [
        'attestation missing sig',
        {
          ...validRecord,
          attestation: { signingKey: validAttestation.signingKey },
        },
      ],
      ['non-string service', { ...validRecord, service: 123 }],
      ['non-string createdAt', { ...validRecord, createdAt: 1995 }],
      [
        'missing signingKey',
        (() => {
          const record = { ...validRecord } as Record<string, unknown>
          delete record.signingKey
          return record
        })(),
      ],
      ['empty object', {}],
      ['null', null],
      ['plain non-object (string)', 'not-an-object'],
    ]

    it.each(cases)('agrees for: %s', (_name, value) => {
      expect(parseEnrollmentRecord(value, 'rkey')).toEqual(
        coreParseEnrollmentRecord(value, 'rkey'),
      )
    })
  })
})
