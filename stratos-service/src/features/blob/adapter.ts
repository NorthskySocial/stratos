import type { Cid } from '@atproto/lex-data'
import {
  type BlobAuthService,
  type BoundaryResolver,
  canAccessRecord,
  StratosValidator,
} from '@northskysocial/stratos-core'
import type { ActorStore } from '../../actor-store-types.js'

/**
 * Implementation of BlobAuthService that uses ActorStore to check record boundaries.
 */
export class BlobAuthServiceImpl implements BlobAuthService {
  constructor(
    private actorStore: ActorStore,
    private boundaryResolver: BoundaryResolver,
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
    // 1. Ownership Bypass: If the viewer is the actor owning the repository, access is granted.
    if (viewerDid && viewerDid === actorDid) {
      return true
    }

    // 2. Unauthenticated viewers cannot access private blobs (Stratos default)
    if (!viewerDid) {
      return false
    }

    // 3. Resolve viewer boundaries
    const viewerDomains = await this.boundaryResolver.getBoundaries(viewerDid)

    // 4. Get all records associated with this blob in the actor's repo
    const exists = await this.actorStore.exists(actorDid)
    if (!exists) {
      return false
    }

    return this.actorStore.read(actorDid, async (store) => {
      // Find all records that reference this blob
      // Note: We need a way to find records by blob CID.
      // The `stratosRecordBlob` table in the database handles this.
      // We should use a method from the actor store that queries this association.

      // For now, let's assume we have a way to get record URIs for a blob CID.
      // Looking at `BlobMetadataReader`, it has `listBlobsForRecord`, but not `listRecordsForBlob`.
      // We might need to add this to the storage layer or use the DB directly if available.

      // In the current architecture, ActorStore provides access to specialized stores.
      // Let's use the underlying DB from the store if possible, or assume a new method.

      // Since I'm implementing the adapter, I should check how to query the association.
      // The `SqliteBlobMetadataReader` has access to `this.db`.

      const recordUris = await store.blob.getRecordsForBlob(blobCid)

      if (!recordUris || recordUris.length === 0) {
        // Orphaned blob or not associated with any record in this repo.
        // For now, deny access to orphaned blobs as per design discussion.
        return false
      }

      // 5. Check if viewer has access to ANY of the records
      for (const uri of recordUris) {
        const record = await store.record.getRecord(uri, null)
        if (record) {
          const recordBoundaries = StratosValidator.extractBoundaryDomains(
            record.value,
          )
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

    // Optimization: Resolve boundaries once
    let viewerDomains: string[] = []
    if (viewerDid) {
      viewerDomains = await this.boundaryResolver.getBoundaries(viewerDid)
    }

    // Simple implementation: call canAccessBlob for each (can be optimized with shared context)
    for (const cid of blobCids) {
      const cidStr = cid.toString()
      // If owner, all true
      if (viewerDid && viewerDid === actorDid) {
        results.set(cidStr, true)
        continue
      }

      // Safety check, if viewer is null, all false
      if (!viewerDid) {
        results.set(cidStr, false)
        continue
      }

      const access = await this.canAccessBlobInternal(
        viewerDid,
        viewerDomains,
        actorDid,
        cid,
      )
      results.set(cidStr, access)
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
        const record = await store.record.getRecord(uri, null)
        if (record) {
          const recordBoundaries = StratosValidator.extractBoundaryDomains(
            record.value,
          )
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
