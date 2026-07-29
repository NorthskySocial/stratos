import type { FetchHandler } from '@atcute/client'
import { Client, simpleFetchHandler } from '@atcute/client'
import '@atcute/atproto'
import type { ServiceAttestation, StratosEnrollment } from './types.js'
import { serviceDIDToRkey } from './routing.js'

// forked from stratos-core/src/enrollment/discovery.ts — client can't depend
// on stratos-core (see scripts/check-self-contained.mjs). kept honest by
// tests/discovery-parity.test.ts.

export const ENROLLMENT_COLLECTION = 'zone.stratos.actor.enrollment'

interface GetRecordResponse {
  uri: string
  value: unknown
}

interface XRPCResponse<T> {
  ok: boolean
  data: T
}

// PDS records may carry the sig as a raw Uint8Array, a Buffer-like, or the
// { $bytes: base64 } JSON encoding — normalize all three.
const decodeBytes = (val: unknown): Uint8Array | null => {
  if (val instanceof Uint8Array) return val
  if (val && typeof val === 'object' && '_isBuffer' in val && val._isBuffer) {
    return val as unknown as Uint8Array
  }
  if (typeof val === 'object' && val !== null && '$bytes' in val) {
    const b64: unknown = (val as { $bytes: unknown }).$bytes
    if (typeof b64 !== 'string') return null
    let binary: string
    try {
      binary = atob(b64)
    } catch {
      return null
    }
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }
  return null
}

const parseAttestation = (val: unknown): ServiceAttestation | null => {
  if (typeof val !== 'object' || val === null) return null
  const obj = val as Record<string, unknown>
  if (typeof obj.signingKey !== 'string') return null
  const sig = decodeBytes(obj.sig)
  if (!sig) return null
  return { sig, signingKey: obj.signingKey }
}

const isBoundary = (val: unknown): val is { value: string } =>
  typeof val === 'object' &&
  val !== null &&
  typeof (val as { value: unknown }).value === 'string'

const parseBoundaries = (val: unknown): Array<{ value: string }> => {
  if (!Array.isArray(val)) return []
  return val.filter(isBoundary)
}

/**
 * Parses an enrollment record from a lexicon-compliant object.
 *
 * @param val - The value of the record.
 * @param rkey - The record key.
 * @returns The parsed enrollment record, or null for invalid records.
 */
export const parseEnrollmentRecord = (
  val: unknown,
  rkey: string,
): StratosEnrollment | null => {
  if (typeof val !== 'object' || val === null) return null
  const obj = val as Record<string, unknown>
  if (typeof obj.service !== 'string') return null
  if (typeof obj.createdAt !== 'string') return null
  if (typeof obj.signingKey !== 'string') return null
  const attestation = parseAttestation(obj.attestation)
  if (!attestation) return null
  return {
    service: obj.service,
    boundaries: parseBoundaries(obj.boundaries),
    signingKey: obj.signingKey,
    attestation,
    createdAt: obj.createdAt,
    rkey,
  }
}

/**
 * discovers a specific Stratos enrollment by the service's DID.
 * uses com.atproto.repo.getRecord with the service DID as the rkey
 * for direct O(1) lookup instead of listing all records.
 *
 * @param did the DID to check for enrollment
 * @param pdsUrlOrHandler the user's PDS service URL or a FetchHandler
 * @param serviceDid the service's DID (e.g., 'did:web:stratos.example.com')
 * @returns the enrollment if found, null otherwise
 */
interface ListRecordsResponse {
  records: Array<{ uri: string; value: unknown }>
}

const toHandler = (pdsUrlOrHandler: string | FetchHandler): FetchHandler =>
  typeof pdsUrlOrHandler === 'string'
    ? simpleFetchHandler({ service: pdsUrlOrHandler })
    : pdsUrlOrHandler

const extractRkey = (uri: string): string => {
  const parts = uri.split('/')
  return parts[parts.length - 1]
}

/**
 * discovers all Stratos enrollments by listing enrollment records
 * from the user's PDS via com.atproto.repo.listRecords.
 *
 * @param did the DID to check for enrollments
 * @param pdsUrlOrHandler the user's PDS service URL or a FetchHandler
 * @returns all valid enrollments, empty array when none exist
 */
export const discoverEnrollments = async (
  did: string,
  pdsUrlOrHandler: string | FetchHandler,
): Promise<StratosEnrollment[]> => {
  const rpc = new Client({ handler: toHandler(pdsUrlOrHandler) })

  try {
    const res = (await rpc.get('com.atproto.repo.listRecords', {
      params: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        repo: did as any,
        collection: ENROLLMENT_COLLECTION,
        limit: 100,
      },
    })) as XRPCResponse<ListRecordsResponse>

    if (!res.ok) return []

    const enrollments: StratosEnrollment[] = []
    for (const record of res.data.records) {
      const rkey = extractRkey(record.uri)
      const enrollment = parseEnrollmentRecord(record.value, rkey)
      if (enrollment) enrollments.push(enrollment)
    }
    return enrollments
  } catch {
    return []
  }
}

/**
 * discovers a single Stratos enrollment from the user's PDS.
 * convenience wrapper around discoverEnrollments that returns the first match.
 *
 * @param did the DID to check for enrollment
 * @param pdsUrlOrHandler the user's PDS service URL or a FetchHandler
 * @returns the first enrollment if any exist, null otherwise
 */
export const discoverEnrollment = async (
  did: string,
  pdsUrlOrHandler: string | FetchHandler,
): Promise<StratosEnrollment | null> => {
  const enrollments = await discoverEnrollments(did, pdsUrlOrHandler)
  return enrollments[0] ?? null
}

export const getEnrollmentByServiceDid = async (
  did: string,
  pdsUrlOrHandler: string | FetchHandler,
  serviceDid: string,
): Promise<StratosEnrollment | null> => {
  const rpc = new Client({ handler: toHandler(pdsUrlOrHandler) })
  const rkey = serviceDIDToRkey(serviceDid)

  try {
    const res = (await rpc.get('com.atproto.repo.getRecord', {
      params: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        repo: did as any,
        collection: ENROLLMENT_COLLECTION,
        rkey,
      },
    })) as XRPCResponse<GetRecordResponse>

    if (!res.ok) return null

    return parseEnrollmentRecord(res.data.value, rkey)
  } catch {
    return null
  }
}
