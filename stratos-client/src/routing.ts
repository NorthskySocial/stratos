import type { FetchHandler, FetchHandlerObject } from '@atcute/client'
import type { StratosEnrollment } from './types.js'

/**
 * converts a service DID to a valid AT Protocol record key.
 * replaces percent-encoded colons (%3A) with literal colons,
 * which are valid rkey characters.
 */
export const serviceDIDToRkey = (serviceDid: string): string => {
  return serviceDid.replace(/%3A/gi, ':')
}

/**
 * creates a fetch handler that routes XRPC calls to a specific service URL
 * using an existing authenticated handler for DPoP credentials.
 *
 * works by resolving relative pathnames against the target service URL.
 * the underlying DPoP fetch derives htu from the actual request URL,
 * so proofs are valid for any origin without reconfiguration.
 *
 * @param authenticatedHandler a handler that attaches auth headers (DPoP proof + access token)
 * @param serviceUrl the target Stratos service base URL
 * @returns a FetchHandlerObject that routes calls to the target service
 */
export const createServiceFetchHandler = (
  authenticatedHandler: FetchHandler,
  serviceUrl: string,
): FetchHandlerObject => {
  return {
    async handle(pathname: string, init?: RequestInit): Promise<Response> {
      const url = new URL(pathname, serviceUrl)
      return authenticatedHandler(url.href, init ?? {})
    },
  }
}

/**
 * resolves the service URL for a given DID.
 * returns the Stratos service URL if enrolled, otherwise falls back.
 *
 * @param enrollment the user's Stratos enrollment, or null if not enrolled
 * @param fallbackUrl the fallback service URL (typically the PDS)
 * @returns the resolved service URL
 */
export const resolveServiceUrl = (
  enrollment: StratosEnrollment | { service: string } | null,
  fallbackUrl: string,
): string => {
  return enrollment?.service ?? fallbackUrl
}

/**
 * finds the enrollment matching a given service URL from a list of enrollments.
 *
 * @param enrollments array of discovered enrollments
 * @param serviceUrl the service URL to match
 * @returns the matching enrollment, or null if not found
 */
export const findEnrollmentByService = <T extends { service: string }>(
  enrollments: Array<T>,
  serviceUrl: string,
): T | null => {
  const normalized = serviceUrl.replace(/\/$/, '')
  return (
    enrollments.find((e) => e.service.replace(/\/$/, '') === normalized) ?? null
  )
}
