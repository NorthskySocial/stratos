import type { Cid } from '@atproto/lex-data'
import {
  type BlobAuthService,
  type BoundaryResolver,
  canAccessRecord,
  type Logger,
} from '@northskysocial/stratos-core'
import type { ActorStore } from '../../actor-store-types.js'
import { logDomainlessInvariant } from '../../shared/domainless-invariant.js'
import {
  type AccountTakedownLog,
  isAccountTakenDown,
} from '../../subscription/takedown-filter.js'

/**
 * Implementation of BlobAuthService that uses ActorStore to check record
 * boundaries. No blob of a taken-down account is served, not even to the
 * owner, whose own reads its hold already refuses.
 */
export class BlobAuthServiceImpl implements BlobAuthService {
  constructor(
    private actorStore: ActorStore,
    private boundaryResolver: BoundaryResolver,
    private takedownLog: AccountTakedownLog,
    private logger?: Logger,
  ) {}

  /**
   * Check if a viewer has access to a specific blob.
   *
   * @param viewerDid - The DID of the viewer.
   * @param actorDid - The DID of the actor (owner of the blob).
   * @param blobCid - The CID of the blob to check access for.
   * @returns A promise that resolves to true if the viewer has access, false otherwise.
   */
  async canAccessBlob(
    viewerDid: string | null,
    actorDid: string,
    blobCid: Cid,
  ): Promise<boolean> {
    // 1. Unauthenticated viewers cannot access private blobs (Stratos default)
    if (!viewerDid) {
      return false
    }

    if (await isAccountTakenDown(this.takedownLog, actorDid)) {
      return false
    }

    // 2. Ownership Bypass: If the viewer is the actor owning the repository, access is granted.
    if (viewerDid === actorDid) {
      return true
    }

    // 3. Resolve viewer boundaries
    const viewerDomains = await this.boundaryResolver.getBoundaries(viewerDid)

    // 4. Get all records associated with this blob in the actor's repo
    const exists = await this.actorStore.exists(actorDid)
    if (!exists) {
      return false
    }

    return this.actorStore.read(actorDid, async (store) => {
      // Access follows the records that reference the blob; none means orphaned
      const recordUris = await store.blob.getRecordsForBlob(blobCid)

      if (!recordUris || recordUris.length === 0) {
        // Orphaned blob or not associated with any record in this repo.
        // For now, deny access to orphaned blobs as per design discussion.
        return false
      }

      // 5. Check if viewer has access to ANY of the records
      for (const uri of recordUris) {
        const found = await store.record.getVisibleRecordWithBoundaries(uri)
        if (found) {
          const recordBoundaries = found.boundaries
          logDomainlessInvariant(this.logger, recordBoundaries, {
            uri: uri.toString(),
            ownerDid: actorDid,
          })
          const hasAccess = canAccessRecord({
            recordBoundaries,
            ownerDid: actorDid,
            context: {
              viewerDid,
              viewerDomains,
            },
          })
          if (hasAccess) {
            return true
          }
        }
      }

      return false
    })
  }

  /**
   * Batch check access for multiple blobs.
   *
   * @param viewerDid - The DID of the viewer.
   * @param actorDid - The DID of the actor (owner of the blobs).
   * @param blobCids - An array of CIDs of the blobs to check access for.
   * @returns A promise that resolves to a map of blob CIDs to access status.
   */
  async canAccessBlobs(
    viewerDid: string | null,
    actorDid: string,
    blobCids: Cid[],
  ): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>()
    const answerAll = (access: boolean) => {
      for (const cid of blobCids) {
        results.set(cid.toString(), access)
      }
      return results
    }

    // Unauthenticated viewers cannot access private blobs (Stratos default)
    if (!viewerDid) {
      return answerAll(false)
    }

    if (await isAccountTakenDown(this.takedownLog, actorDid)) {
      return answerAll(false)
    }

    // Ownership bypass: if viewer is the actor owning the repository, access is granted for all blobs.
    if (viewerDid === actorDid) {
      return answerAll(true)
    }

    // Optimization: Resolve boundaries once for the batch
    const viewerDomains = await this.boundaryResolver.getBoundaries(viewerDid)

    for (const cid of blobCids) {
      const access = await this.canAccessBlobInternal(
        viewerDid,
        viewerDomains,
        actorDid,
        cid,
      )
      results.set(cid.toString(), access)
    }

    return results
  }

  /**
   * Check if a viewer has access to a specific blob.
   *
   * @param viewerDid - The DID of the viewer.
   * @param viewerDomains - The domains associated with the viewer.
   * @param actorDid - The DID of the actor (owner of the blob).
   * @param blobCid - The CID of the blob to check access for.
   * @returns A promise that resolves to true if the viewer has access, false otherwise.
   * @private
   */
  private async canAccessBlobInternal(
    viewerDid: string,
    viewerDomains: string[],
    actorDid: string,
    blobCid: Cid,
  ): Promise<boolean> {
    const exists = await this.actorStore.exists(actorDid)
    if (!exists) return false

    return this.actorStore.read(actorDid, async (store) => {
      const recordUris = await store.blob.getRecordsForBlob(blobCid)
      if (!recordUris || recordUris.length === 0) return false

      for (const uri of recordUris) {
        const found = await store.record.getVisibleRecordWithBoundaries(uri)
        if (found) {
          const recordBoundaries = found.boundaries
          logDomainlessInvariant(this.logger, recordBoundaries, {
            uri: uri.toString(),
            ownerDid: actorDid,
          })
          const hasAccess = canAccessRecord({
            recordBoundaries,
            ownerDid: actorDid,
            context: { viewerDid, viewerDomains },
          })
          if (hasAccess) return true
        }
      }
      return false
    })
  }
}
