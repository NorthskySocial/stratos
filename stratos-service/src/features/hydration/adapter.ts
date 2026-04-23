import { AtUri as AtUriSyntax, AtUri } from '@atproto/syntax'
import type {
  BatchHydrationResult,
  BoundaryResolver,
  HydratedRecord,
  HydrationContext,
  HydrationRequest,
  HydrationResult,
  HydrationService,
  RecordResolver,
} from '@northskysocial/stratos-core'
import { canAccessRecord, StratosValidator } from '@northskysocial/stratos-core'
import type { ActorStore } from '../../actor-store-types.js'

/**
 * Implementation of RecordResolver port using actor store
 */
export class ActorStoreRecordResolver implements RecordResolver {
  constructor(private actorStore: ActorStore) {}

  /**
   * Retrieve a record from the actor store for a given owner DID and URI.
   * @param ownerDid - The DID of the record owner.
   * @param uri - The URI of the record to retrieve.
   * @returns A Promise resolving to the hydrated record or null if not found.
   */
  async getRecord(
    ownerDid: string,
    uri: string,
  ): Promise<{
    uri: string
    cid: string
    value: Record<string, unknown>
    boundaries: string[]
  } | null> {
    const exists = await this.actorStore.exists(ownerDid)
    if (!exists) {
      return null
    }

    return this.actorStore.read(ownerDid, async (store) => {
      const atUri = new AtUriSyntax(uri)
      const record = await store.record.getRecord(atUri, null)
      if (!record) {
        return null
      }

      const boundaries = StratosValidator.extractBoundaryDomains(record.value)
      return {
        uri: record.uri,
        cid: record.cid,
        value: record.value,
        boundaries,
      }
    })
  }

  /**
   * Get records from the actor store for a given owner DID and array of URIs.
   * @param ownerDid - Decentralized identifier (DID) of the owner.
   * @param uris - Array of AtUri instances representing the records to retrieve.
   * @returns A Map of AtUri instances to record details, or null if the owner DID does not exist.
   */
  async getRecords(
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
  > {
    const result = new Map<
      AtUri,
      {
        uri: string
        cid: string
        value: Record<string, unknown>
        boundaries: string[]
      }
    >()

    const exists = await this.actorStore.exists(ownerDid)
    if (!exists) {
      return result
    }

    await this.actorStore.read(ownerDid, async (store) => {
      for (const uriStr of uris) {
        const atUri = new AtUriSyntax(uriStr)
        const record = await store.record.getRecord(atUri, null)
        if (record) {
          const boundaries = StratosValidator.extractBoundaryDomains(
            record.value,
          )
          // eslint-disable-next-line @typescript-eslint/no-explicit-any,@typescript-eslint/no-unsafe-argument
          result.set(atUri.toString() as any, {
            uri: record.uri,
            cid: record.cid,
            value: record.value,
            boundaries,
          })
        }
      }
    })

    return result
  }
}

/**
 * Implementation of HydrationService port
 */
export class HydrationServiceImpl implements HydrationService {
  constructor(
    private recordResolver: RecordResolver,
    private boundaryResolver: BoundaryResolver,
  ) {}

  /**
   * Hydrate a single record based on the provided request and context.
   * @param request - The hydration request containing the URI to hydrate.
   * @param context - The hydration context, which may include additional parameters.
   * @returns A promise that resolves to the hydration result, which includes the status, URI, and optional message.
   */
  async hydrateRecord(
    request: HydrationRequest,
    context: HydrationContext,
  ): Promise<HydrationResult> {
    const { uri } = request

    // Parse the URI to get the owner DID
    let atUri: AtUriSyntax
    try {
      atUri = new AtUriSyntax(uri)
    } catch {
      return { status: 'error', uri, message: 'Invalid AT-URI' }
    }

    const ownerDid = atUri.hostname

    // Get the record
    const record = await this.recordResolver.getRecord(ownerDid, uri)
    if (!record) {
      return { status: 'not-found', uri }
    }

    // Check if CID matches (if specified)
    if (request.cid && record.cid !== request.cid) {
      return { status: 'not-found', uri }
    }

    // Resolve viewer domains if not provided
    let viewerDomains = context.viewerDomains
    if (context.viewerDid && viewerDomains.length === 0) {
      viewerDomains = await this.boundaryResolver.getBoundaries(
        context.viewerDid,
      )
    }

    // Check access
    const hasAccess = canAccessRecord({
      recordBoundaries: record.boundaries,
      ownerDid,
      context: { ...context, viewerDomains },
    })

    if (!hasAccess) {
      return { status: 'blocked', uri, reason: 'boundary' }
    }

    return {
      status: 'success',
      record: {
        uri: record.uri,
        cid: record.cid,
        value: record.value,
      },
    }
  }

  /**
   * Hydrate multiple records based on the provided requests and context.
   * @param requests - Array of hydration requests, each containing a URI to hydrate.
   * @param context - The hydration context, which may include additional parameters.
   * @returns A promise that resolves to the batch hydration result, which includes the status, URI, and optional message for each request.
   */
  async hydrateRecords(
    requests: HydrationRequest[],
    context: HydrationContext,
  ): Promise<BatchHydrationResult> {
    const records: HydratedRecord[] = []
    const notFound: string[] = []
    const blocked: string[] = []

    // Resolve viewer domains once if authenticated
    let viewerDomains = context.viewerDomains
    if (context.viewerDid && viewerDomains.length === 0) {
      viewerDomains = await this.boundaryResolver.getBoundaries(
        context.viewerDid,
      )
    }

    const resolvedContext = { ...context, viewerDomains }

    const byOwner = this.groupRequestsByOwner(requests)

    // Process each owner's records
    for (const [ownerDid, ownerRequests] of byOwner) {
      const uris = ownerRequests.map((r) => r.uri)
      const recordMap = await this.recordResolver.getRecords(ownerDid, uris)

      for (const request of ownerRequests) {
        this.processHydrationRequest(
          request,
          ownerDid,
          recordMap,
          resolvedContext,
          records,
          notFound,
          blocked,
        )
      }
    }

    return { records, notFound, blocked }
  }

  /**
   * Group hydration requests by owner DID
   * @param requests - Array of hydration requests
   * @returns Map of owner DIDs to arrays of hydration requests
   * @private
   */
  private groupRequestsByOwner(
    requests: HydrationRequest[],
  ): Map<string, HydrationRequest[]> {
    const byOwner = new Map<string, HydrationRequest[]>()
    for (const request of requests) {
      try {
        const atUri = new AtUriSyntax(request.uri)
        const ownerDid = atUri.hostname
        const existing = byOwner.get(ownerDid) ?? []
        existing.push(request)
        byOwner.set(ownerDid, existing)
      } catch {
        // Invalid URI - mark as not found handled later or here
      }
    }
    return byOwner
  }

  /**
   * Process hydration request
   * @param request - Hydration request
   * @param ownerDid - DID of the owner
   * @param recordMap - Map of records
   * @param context - Hydration context
   * @param records - Array of hydrated records
   * @param notFound - Array of not found URIs
   * @param blocked - Array of blocked URIs
   * @private
   */
  private processHydrationRequest(
    request: HydrationRequest,
    ownerDid: string,
    recordMap: Map<
      AtUri,
      { uri: string; cid: string; value: unknown; boundaries: string[] }
    >,
    context: HydrationContext,
    records: HydratedRecord[],
    notFound: string[],
    blocked: string[],
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any,@typescript-eslint/no-unsafe-argument
    const record = recordMap.get(request.uri as any)

    if (!record || (request.cid && record.cid !== request.cid)) {
      notFound.push(request.uri)
      return
    }

    // Check access
    const hasAccess = canAccessRecord({
      recordBoundaries: record.boundaries,
      ownerDid,
      context,
    })

    if (!hasAccess) {
      blocked.push(request.uri)
      return
    }

    records.push({
      uri: record.uri,
      cid: record.cid,
      value: record.value as Record<string, unknown>,
    })
  }
}
