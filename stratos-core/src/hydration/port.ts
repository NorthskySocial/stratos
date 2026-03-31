import type { AtUri } from '../shared/index.js'
import type {
  BatchHydrationResult,
  HydrationContext,
  HydrationRequest,
  HydrationResult,
} from './types.js'

// Re-export BoundaryResolver for convenience when using hydration module
export type { BoundaryResolver } from '../enrollment/port.js'

/**
 * Service for hydrating records from a Stratos namespace.
 *
 * Hydration is the process of retrieving the full record content
 * for stub records that were written to a user's PDS but whose
 * actual content lives in the Stratos private namespace.
 */
export interface HydrationService {
  /**
   * Hydrate a single record
   *
   * @param request - The hydration request with URI and optional CID
   * @param context - Viewer context for access control
   * @returns The hydrated record or null if not found/not accessible
   */
  hydrateRecord(
    request: HydrationRequest,
    context: HydrationContext,
  ): Promise<HydrationResult>

  /**
   * Hydrate multiple records in a batch
   *
   * @param requests - Array of hydration requests
   * @param context - Viewer context for access control
   * @returns Batch result with records, not found URIs, and blocked URIs
   */
  hydrateRecords(
    requests: HydrationRequest[],
    context: HydrationContext,
  ): Promise<BatchHydrationResult>
}

/**
 * Resolver for looking up records in actor stores
 */
export interface RecordResolver {
  /**
   * Get a record by URI
   *
   * @param ownerDid - DID of the record owner
   * @param uri - AT-URI of the record
   * @returns Record with boundaries, or null if not found
   */
  getRecord(
    ownerDid: string,
    uri: string,
  ): Promise<{
    uri: string
    cid: string
    value: Record<string, unknown>
    boundaries: string[]
  } | null>

  /**
   * Get multiple records by URIs
   *
   * @param ownerDid - DID of the record owner
   * @param uris - AT-URIs of the records
   * @returns Map of URI to record with boundaries
   */
  getRecords(
    ownerDid: string,
    uris: string[],
  ): Promise<
    Map<
      AtUri,
      {
        uri: string
        cid: string
        value: Record<string, unknown>
        boundaries: string[]
      }
    >
  >
}
