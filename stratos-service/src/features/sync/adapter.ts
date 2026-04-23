import { CID } from 'multiformats/cid'
import { InvalidRequestError } from '@atproto/xrpc-server'
import type { BoundaryResolver } from '@northskysocial/stratos-core'
import { parseCid } from '@northskysocial/stratos-core'
import type { ActorStore } from '../../actor-store-types.js'
import type { BloomManager } from '../blob'

export interface GetBlobResult {
  stream: AsyncIterable<Uint8Array>
  mimeType: string
  size: number
}

export interface SyncService {
  getBlob(
    did: string,
    cid: string | CID,
    viewerDid: string | null,
  ): Promise<GetBlobResult>
}

/**
 * Implementation of SyncService port.
 */
export class SyncServiceImpl implements SyncService {
  constructor(
    private readonly actorStore: ActorStore,
    private readonly bloomManager: BloomManager,
    private readonly boundaryResolver: BoundaryResolver,
  ) {}

  /**
   * Get a blob by CID.
   * @param did - The DID of the actor.
   * @param cidStr - The CID of the blob.
   * @param viewerDid - The DID of the viewer.
   * @returns A promise that resolves to the blob.
   * @throws InvalidRequestError if the blob is not found or access is denied.
   * @throws AuthRequiredError if the viewer is not authenticated.
   */
  async getBlob(
    did: string,
    cidStr: string | CID,
    viewerDid: string | null,
  ): Promise<GetBlobResult> {
    console.debug(
      `[DEBUG_LOG] SyncServiceImpl.getBlob: did=${did}, cid=${cidStr}, viewerDid=${viewerDid}`,
    )
    if (!did) {
      throw new InvalidRequestError('did is required')
    }
    if (!cidStr) {
      throw new InvalidRequestError('cid is required')
    }

    const cid = typeof cidStr === 'string' ? parseCid(cidStr) : cidStr

    // 1. Resolve viewer boundaries
    const userBoundaries = viewerDid
      ? await this.boundaryResolver.getBoundaries(viewerDid)
      : []
    console.debug(
      `[DEBUG_LOG] SyncServiceImpl.getBlob: userBoundaries=${JSON.stringify(userBoundaries)}`,
    )

    // 2. Access Control Logic
    // Ownership Bypass: If the viewer is the actor owning the repository, access is granted.
    if (viewerDid === did) {
      console.debug(
        `[DEBUG_LOG] SyncServiceImpl.getBlob: Access granted (owner)`,
      )
    } else {
      // For all other cases, check boundaries
      // 3. Bloom Fast Rejection
      const likelyHasAccess = this.bloomManager.checkBloom(cid, userBoundaries)
      console.debug(
        `[DEBUG_LOG] SyncServiceImpl.getBlob: likelyHasAccess=${likelyHasAccess}`,
      )

      if (!likelyHasAccess) {
        if (!viewerDid) {
          throw new InvalidRequestError(
            'Authentication required to access private blob',
            'AuthenticationRequired',
          )
        }
        throw new InvalidRequestError(
          'Access denied to blob due to boundary restrictions (fast rejection)',
          'BlobBlocked',
        )
      }

      // 4. Authoritative Check: Query blob_boundaries via ActorStore
      const hasAccess = await this.actorStore.read(did, async (store) => {
        const blobBoundaries = await store.blob.getBoundariesForBlob(cid)
        console.debug(
          `[DEBUG_LOG] SyncServiceImpl.getBlob: blobBoundaries=${JSON.stringify(blobBoundaries)}`,
        )

        // If no boundaries associated, it's public (to the network)
        if (blobBoundaries.length === 0) {
          return true
        }

        return userBoundaries.some((b) => blobBoundaries.includes(b))
      })

      if (!hasAccess) {
        if (!viewerDid) {
          throw new InvalidRequestError(
            'Authentication required to access private blob',
            'AuthenticationRequired',
          )
        }
        throw new InvalidRequestError(
          'Access denied to blob due to boundary restrictions',
          'BlobBlocked',
        )
      }
    }

    // 5. Stream Response
    const exists = await this.actorStore.exists(did)
    if (!exists) {
      throw new InvalidRequestError('Could not find repo', 'RepoNotFound')
    }

    const blob = await this.actorStore.read(did, async (store) => {
      const result = await store.blob.getBlob(cid)
      if (!result) return null

      return {
        mimeType: result.mimeType ?? 'application/octet-stream',
        size: result.size,
        stream: result.stream,
      }
    })

    if (!blob) {
      throw new InvalidRequestError('Blob not found', 'BlobNotFound')
    }

    return blob
  }
}
