import { AtUri } from '@atproto/syntax'
import type {
  HydrationService,
  HydrationRequest,
  HydrationContext,
  HydrationResult,
  BatchHydrationResult,
  HydratedRecord,
  RecordResolver,
  BoundaryResolver,
} from '@northsky/stratos-core'
import {
  canAccessRecord,
  extractBoundaryDomains,
} from '@northsky/stratos-core'
import type { StratosActorStore } from '../../context.js'

/**
 * Implementation of RecordResolver port using actor store
 */
export class ActorStoreRecordResolver implements RecordResolver {
  constructor(private actorStore: StratosActorStore) {}

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
      const atUri = new AtUri(uri)
      const record = await store.record.getRecord(atUri, null)
      if (!record) {
        return null
      }

      const boundaries = extractBoundaryDomains(record.value)
      return {
        uri: record.uri,
        cid: record.cid,
        value: record.value,
        boundaries,
      }
    })
  }

  async getRecords(
    ownerDid: string,
    uris: string[],
  ): Promise<
    Map<
      string,
      {
        uri: string
        cid: string
        value: Record<string, unknown>
        boundaries: string[]
      }
    >
  > {
    const result = new Map<
      string,
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
      for (const uri of uris) {
        const atUri = new AtUri(uri)
        const record = await store.record.getRecord(atUri, null)
        if (record) {
          const boundaries = extractBoundaryDomains(record.value)
          result.set(uri, {
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

  async hydrateRecord(
    request: HydrationRequest,
    context: HydrationContext,
  ): Promise<HydrationResult> {
    const { uri } = request

    // Parse the URI to get the owner DID
    let atUri: AtUri
    try {
      atUri = new AtUri(uri)
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

    // Group requests by owner DID for efficient batching
    const byOwner = new Map<string, HydrationRequest[]>()
    for (const request of requests) {
      try {
        const atUri = new AtUri(request.uri)
        const ownerDid = atUri.hostname
        const existing = byOwner.get(ownerDid) ?? []
        existing.push(request)
        byOwner.set(ownerDid, existing)
      } catch {
        // Invalid URI - mark as not found
        notFound.push(request.uri)
      }
    }

    // Process each owner's records
    for (const [ownerDid, ownerRequests] of byOwner) {
      const uris = ownerRequests.map((r) => r.uri)
      const recordMap = await this.recordResolver.getRecords(ownerDid, uris)

      for (const request of ownerRequests) {
        const record = recordMap.get(request.uri)

        if (!record) {
          notFound.push(request.uri)
          continue
        }

        // Check CID if specified
        if (request.cid && record.cid !== request.cid) {
          notFound.push(request.uri)
          continue
        }

        // Check access
        const hasAccess = canAccessRecord({
          recordBoundaries: record.boundaries,
          ownerDid,
          context: resolvedContext,
        })

        if (!hasAccess) {
          blocked.push(request.uri)
          continue
        }

        records.push({
          uri: record.uri,
          cid: record.cid,
          value: record.value,
        })
      }
    }

    return { records, notFound, blocked }
  }
}
