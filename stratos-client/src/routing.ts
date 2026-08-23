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
 * options for createServiceFetchHandler.
 */
export interface ServiceFetchHandlerOptions {
  /**
   * extra headers to set on every routed request, for example development
   * tunnel bypass headers. these headers replace the per-request headers
   * that use the same name.
   */
  headers?: HeadersInit
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
 * @param options optional configuration (extra headers)
 * @returns a FetchHandlerObject that routes calls to the target service
 */
export const createServiceFetchHandler = (
  authenticatedHandler: FetchHandler,
  serviceUrl: string,
  options?: ServiceFetchHandlerOptions,
): FetchHandlerObject => {
  return {
    async handle(pathname: string, init?: RequestInit): Promise<Response> {
      const url = new URL(pathname, serviceUrl)
      if (!options?.headers) {
        return authenticatedHandler(url.href, init ?? {})
      }
      const headers = new Headers(init?.headers)
      new Headers(options.headers).forEach((value, name) => {
        headers.set(name, value)
      })
      return authenticatedHandler(url.href, { ...init, headers })
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
