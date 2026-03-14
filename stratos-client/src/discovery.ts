import '@atcute/atproto'
import { Client, simpleFetchHandler } from '@atcute/client'
import type { FetchHandler } from '@atcute/client'
import type { ServiceAttestation, StratosEnrollment } from './types.js'

const ENROLLMENT_COLLECTION = 'zone.stratos.actor.enrollment'
const ENROLLMENT_RKEY = 'self'

const decodeBytes = (val: unknown): Uint8Array | null => {
  if (val instanceof Uint8Array) return val
  if (typeof val === 'object' && val !== null && '$bytes' in val) {
    const b64 = (val as { $bytes: string }).$bytes
    if (typeof b64 !== 'string') return null
    const binary = atob(b64)
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

const parseEnrollmentRecord = (val: unknown): StratosEnrollment | null => {
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
  }
}

/**
 * discovers a Stratos enrollment by reading the enrollment record
 * from the user's PDS via com.atproto.repo.getRecord.
 *
 * accepts either a PDS URL string (creates an unauthenticated client)
 * or an existing FetchHandler for authenticated/custom transports.
 *
 * @param did the DID to check for enrollment
 * @param pdsUrlOrHandler the user's PDS service URL or a FetchHandler
 * @returns the enrollment if found, null otherwise
 */
export const discoverEnrollment = async (
  did: string,
  pdsUrlOrHandler: string | FetchHandler,
): Promise<StratosEnrollment | null> => {
  const handler =
    typeof pdsUrlOrHandler === 'string'
      ? simpleFetchHandler({ service: pdsUrlOrHandler })
      : pdsUrlOrHandler

  const rpc = new Client({ handler })

  const res = await rpc.get('com.atproto.repo.getRecord', {
    params: {
      repo: did as `did:${string}:${string}`,
      collection: ENROLLMENT_COLLECTION,
      rkey: ENROLLMENT_RKEY,
    },
  })

  if (!res.ok) return null
  return parseEnrollmentRecord(res.data.value)
}
