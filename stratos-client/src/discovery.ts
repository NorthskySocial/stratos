import '@atcute/atproto'
import { Client, simpleFetchHandler } from '@atcute/client'
import type { FetchHandler } from '@atcute/client'
import type { StratosEnrollment } from './types.js'

const ENROLLMENT_COLLECTION = 'app.northsky.stratos.actor.enrollment'
const ENROLLMENT_RKEY = 'self'

const isEnrollmentRecord = (
  val: unknown,
): val is {
  service: string
  boundaries?: Array<{ value: string }>
  createdAt: string
} => {
  if (typeof val !== 'object' || val === null) return false
  const obj = val as Record<string, unknown>
  return typeof obj.service === 'string' && typeof obj.createdAt === 'string'
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

  const val = res.data.value
  if (!isEnrollmentRecord(val)) return null

  return {
    service: val.service,
    boundaries: Array.isArray(val.boundaries) ? val.boundaries : [],
    createdAt: val.createdAt,
  }
}
