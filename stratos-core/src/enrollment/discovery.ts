import type { FetchHandler } from '@atcute/client'
import { Client, simpleFetchHandler } from '@atcute/client'
import '@atcute/atproto'

/**
 * converts a service DID to a valid AT Protocol record key.
 * replaces percent-encoded colons (%3A) with literal colons,
 * which are valid rkey characters.
 */
export const serviceDIDToRkey = (serviceDid: string): string => {
  return serviceDid.replace(/%3A/gi, ':')
}

export const ENROLLMENT_COLLECTION = 'zone.stratos.actor.enrollment'

export interface ServiceAttestation {
  sig: Uint8Array
  signingKey: string
}

export interface StratosEnrollment {
  service: string
  boundaries: Array<{ value: string }>
  signingKey: string
  attestation: ServiceAttestation
  createdAt: string
  rkey: string
}

interface GetRecordResponse {
  uri: string
  value: unknown
}

interface XRPCResponse<T> {
  ok: boolean
  data: T
}

/**
 * Decodes bytes from various formats into Uint8Array.
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
 *
 * @param val - The object to parse.
 * @returns The parsed attestation data, or null if parsing fails.
 */
const parseAttestation = (val: unknown): ServiceAttestation | null => {
  if (typeof val !== 'object' || val === null) return null
  const obj = val as Record<string, unknown>
  if (typeof obj.signingKey !== 'string') return null
  const sig = decodeBytes(obj.sig)
  if (!sig) return null
  return { sig, signingKey: obj.signingKey }
}

/**
 * Parses an enrollment record from a lexicon-compliant object.
 *
 * @param val - The value of the record.
 * @param rkey - The record key.
 * @returns The parsed enrollment record, or null if parsing fails.
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
    boundaries: Array.isArray(obj.boundaries) ? obj.boundaries : [],
    signingKey: obj.signingKey,
    attestation,
    createdAt: obj.createdAt,
    rkey,
  }
}

/**
 * Discovers a specific Stratos enrollment by the service's DID.
 *
 * @param did - The DID of the user.
 * @param pdsUrlOrHandler - The PDS URL or fetch handler.
 * @param serviceDid - The service DID to search for.
 * @returns The discovered enrollment, or null if not found.
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
