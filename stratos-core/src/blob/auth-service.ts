import type { Cid } from '@atproto/lex-data'

/**
 * Service for authorizing access to blobs based on record boundaries.
 */
export interface BlobAuthService {
  /**
   * Check if a viewer has access to a specific blob.
   *
   * @param viewerDid - DID of the viewer (null for unauthenticated)
   * @param actorDid - DID of the repository owner
   * @param blobCid - CID of the blob to check
   * @returns Promise resolving to true if access is granted, false otherwise
   */
  canAccessBlob: (
    viewerDid: string | null,
    actorDid: string,
    blobCid: Cid,
  ) => Promise<boolean>

  /**
   * Batch check access for multiple blobs in the same repository.
   *
   * @param viewerDid - DID of the viewer (null for unauthenticated)
   * @param actorDid - DID of the repository owner
   * @param blobCids - Array of blob CIDs to check
   * @returns Promise resolving to a Map of blob CID string to boolean
   */
  canAccessBlobs: (
    viewerDid: string | null,
    actorDid: string,
    blobCids: Cid[],
  ) => Promise<Map<string, boolean>>
}
