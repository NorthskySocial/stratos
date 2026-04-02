import '@atcute/atproto'
import type { FetchHandler } from '@atcute/client'
import {
  discoverEnrollments as coreDiscoverEnrollments,
  getEnrollmentByServiceDid as coreGetEnrollmentByServiceDid,
  type StratosEnrollment,
} from '@northskysocial/stratos-core'

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
export const discoverEnrollments = coreDiscoverEnrollments

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
export const getEnrollmentByServiceDid = coreGetEnrollmentByServiceDid
