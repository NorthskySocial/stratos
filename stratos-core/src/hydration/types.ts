import type { RecordSource } from '../stub'

/**
 * Context for hydration requests - contains viewer information
 */
export interface HydrationContext {
  /** DID of the viewer requesting hydration (null for unauthenticated) */
  viewerDid: string | null
  /** Boundary domains the viewer has access to */
  viewerDomains: string[]
  /** Base URL of the Stratos service for blob hydration */
  serviceUrl?: string
}

/**
 * Request to hydrate a single record
 */
export interface HydrationRequest {
  /** AT-URI of the record to hydrate */
  uri: string
  /** Optional CID for integrity verification */
  cid?: string
}

/**
 * Result of hydrating a record
 */
export interface HydratedRecord {
  /** AT-URI of the record */
  uri: string
  /** CID of the record */
  cid: string
  /** The full record value */
  value: Record<string, unknown>
}

/**
 * Result of a hydration attempt
 */
export type HydrationResult =
  | { status: 'success'; record: HydratedRecord }
  | { status: 'not-found'; uri: string }
  | { status: 'blocked'; uri: string; reason: 'boundary' | 'takedown' }
  | { status: 'error'; uri: string; message: string }

/**
 * Batch hydration response
 */
export interface BatchHydrationResult {
  /** Successfully hydrated records */
  records: HydratedRecord[]
  /** URIs that were not found */
  notFound: string[]
  /** URIs that were blocked due to boundary restrictions */
  blocked: string[]
}

/**
 * Record that needs hydration (stub with source field)
 */
export interface HydratableRecord {
  /** AT-URI of the record */
  uri: string
  /** The source field indicating where to hydrate from */
  source: RecordSource
}

/**
 * Input for checking if viewer can access a record
 */
export interface AccessCheckInput {
  /** Boundary domains on the record */
  recordBoundaries: string[]
  /** DID of the record owner */
  ownerDid: string
  /** Hydration context with viewer info */
  context: HydrationContext
}
