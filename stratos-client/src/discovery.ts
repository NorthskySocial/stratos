import '@atcute/atproto'
import { getEnrollmentByServiceDid as coreGetEnrollmentByServiceDid } from '@northskysocial/stratos-core/enrollment'

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
