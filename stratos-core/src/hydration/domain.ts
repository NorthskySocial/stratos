import type { AccessCheckInput, HydrationContext } from './types.js'

/**
 * Check if a viewer has access to a record based on boundary intersection
 *
 * Access is granted if:
 * 1. The viewer is the owner of the record
 * 2. The record has no boundaries (public to enrolled users)
 * 3. The viewer shares at least one boundary domain with the record
 *
 * @param input - Access check input containing record boundaries and viewer context
 * @returns true if the viewer can access the record
 */
export function canAccessRecord(input: AccessCheckInput): boolean {
  const { recordBoundaries, ownerDid, context } = input

  // Owner always has access to their own records
  if (context.viewerDid === ownerDid) {
    return true
  }

  // Unauthenticated viewers cannot access private records
  if (context.viewerDid === null) {
    return false
  }

  // Record with no boundaries is accessible to all enrolled users
  if (recordBoundaries.length === 0) {
    return true
  }

  // Check for boundary intersection
  return hasIntersection(recordBoundaries, context.viewerDomains)
}

/**
 * Check if two arrays have at least one common element
 */
export function hasIntersection(a: string[], b: string[]): boolean {
  const setB = new Set(b)
  return a.some((item) => setB.has(item))
}

/**
 * Filter a list of records to only those the viewer can access
 *
 * @param records - Records with their boundaries and owner info
 * @param context - Hydration context with viewer info
 * @returns Records the viewer can access
 */
export function filterAccessibleRecords<
  T extends { boundaries: string[]; ownerDid: string },
>(records: T[], context: HydrationContext): T[] {
  return records.filter((record) =>
    canAccessRecord({
      recordBoundaries: record.boundaries,
      ownerDid: record.ownerDid,
      context,
    }),
  )
}

/**
 * Extract the service DID from a source endpoint URL
 *
 * @param serviceEndpoint - The service endpoint URL (e.g., "https://stratos.example.com")
 * @returns The service DID in did:web format, or null if invalid
 */
export function parseServiceEndpoint(serviceEndpoint: string): string | null {
  try {
    console.debug(`Parsing service endpoint: ${serviceEndpoint}`)
    const url = new URL(serviceEndpoint)
    // Convert hostname to did:web format
    // e.g., stratos.example.com -> did:web:stratos.example.com
    return `did:web:${url.hostname}`
  } catch {
    return null
  }
}

/**
 * Validate that a hydration request is for the current service
 *
 * @param sourceServiceDid - DID from the stub's source field
 * @param currentServiceDid - DID of the current Stratos service
 * @returns true if this service should handle the hydration
 */
export function isLocalService(
  sourceServiceDid: string,
  currentServiceDid: string,
): boolean {
  return sourceServiceDid === currentServiceDid
}

/**
 * Create a hydration context from viewer information
 *
 * @param viewerDid - DID of the viewer (null for unauthenticated)
 * @param viewerDomains - Boundary domains the viewer has access to
 * @returns HydrationContext object
 */
export function createHydrationContext(
  viewerDid: string | null,
  viewerDomains: string[],
): HydrationContext {
  return {
    viewerDid,
    viewerDomains,
  }
}
