import '@atcute/atproto'
import type { FetchHandler } from '@atcute/client'
import { Client, simpleFetchHandler } from '@atcute/client'
import type { ServiceAttestation, StratosEnrollment } from './types.js'
import { serviceDIDToRkey } from './routing.js'

const ENROLLMENT_COLLECTION = 'zone.stratos.actor.enrollment'

/**
 * Decodes bytes from various formats into Uint8Array.
 * @param val - The value to decode.
 * @returns Uint8Array if decoding is successful, null otherwise.
 */
const decodeBytes = (val: unknown): Uint8Array | null => {
  if (val instanceof Uint8Array) return val
  if (val && typeof val === 'object' && '_isBuffer' in val && val._isBuffer) {
    return val as unknown as Uint8Array
  }
  if (typeof val === 'object' && val !== null && '$bytes' in val) {
    const b64: string = (val as { $bytes: string }).$bytes
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }
  return null
}

/**
 * Parses attestation data from a given object.
 * @param val - The object containing attestation data.
 * @returns ServiceAttestation if parsing is successful, null otherwise.
 */
const parseAttestation = (val: unknown): ServiceAttestation | null => {
  if (typeof val !== 'object' || val === null) return null
  const obj = val as Record<string, unknown>
  if (typeof obj.signingKey !== 'string') return null
  const sig = decodeBytes(obj.sig)
  if (!sig) return null
  return { sig, signingKey: obj.signingKey }
}

const parseEnrollmentRecord = (
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
    boundaries: Array.isArray(obj.boundaries) ? obj.boundaries : [],
    signingKey: obj.signingKey,
    attestation,
    createdAt: obj.createdAt,
    rkey,
  }
}

/**
 * extracts the rkey from an AT URI: at://did/collection/rkey
 */
const extractRkey = (uri: string): string => {
  const parts = uri.split('/')
  return parts[parts.length - 1]
}

/**
 * discovers all Stratos enrollments by listing enrollment records
 * from the user's PDS via com.atproto.repo.listRecords.
 *
 * accepts either a PDS URL string (creates an unauthenticated client)
 * or an existing FetchHandler for authenticated/custom transports.
 *
 * @param did the DID to check for enrollments
 * @param pdsUrlOrHandler the user's PDS service URL or a FetchHandler
 * @returns array of enrollments found, empty if none
 */
export const discoverEnrollments = async (
  did: string,
  pdsUrlOrHandler: string | FetchHandler,
): Promise<StratosEnrollment[]> => {
  const handler =
    typeof pdsUrlOrHandler === 'string'
      ? simpleFetchHandler({ service: pdsUrlOrHandler })
      : pdsUrlOrHandler

  const rpc = new Client({ handler })

  const res = await rpc.get('com.atproto.repo.listRecords', {
    params: {
      repo: did as `did:${string}:${string}`,
      collection: ENROLLMENT_COLLECTION,
      limit: 100,
    },
  })

  if (!res.ok) return []

  const enrollments: StratosEnrollment[] = []
  for (const record of res.data.records) {
    const rkey = extractRkey(record.uri)
    const enrollment = parseEnrollmentRecord(record.value, rkey)
    if (enrollment) {
      enrollments.push(enrollment)
    }
  }
  return enrollments
}

/**
 * discovers a single Stratos enrollment from the user's PDS.
 * convenience wrapper around discoverEnrollments that returns the first match.
 *
 * @param did the DID to check for enrollment
 * @param pdsUrlOrHandler the user's PDS service URL or a FetchHandler
 * @returns the first enrollment if found, null otherwise
 */
export const discoverEnrollment = async (
  did: string,
  pdsUrlOrHandler: string | FetchHandler,
): Promise<StratosEnrollment | null> => {
  const enrollments = await discoverEnrollments(did, pdsUrlOrHandler)
  return enrollments[0] ?? null
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
export const getEnrollmentByServiceDid = async (
  did: string,
  pdsUrlOrHandler: string | FetchHandler,
  serviceDid: string,
): Promise<StratosEnrollment | null> => {
  const handler =
    typeof pdsUrlOrHandler === 'string'
      ? simpleFetchHandler({ service: pdsUrlOrHandler })
      : pdsUrlOrHandler

  const rpc = new Client({ handler })
  const rkey = serviceDIDToRkey(serviceDid)

  try {
    const res = await rpc.get('com.atproto.repo.getRecord', {
      params: {
        repo: did as `did:${string}:${string}`,
        collection: ENROLLMENT_COLLECTION,
        rkey,
      },
    })

    if (!res.ok) return null

    return parseEnrollmentRecord(res.data.value, rkey)
  } catch {
    return null
  }
}
