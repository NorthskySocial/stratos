import type { BoundaryResolver } from '@northskysocial/stratos-core'
import type { ActorStore } from '../../actor-store-types.js'
import { BlobAuthServiceImpl } from './adapter.js'
import { BloomManager } from './bloom-manager.js'

/**
 * Initialize blob support.
 * @param actorStore - Store for actor repositories.
 * @param boundaryResolver - Resolver for viewer boundaries.
 * @returns Initialized blob authentication service and BloomManager.
 */
export function initBlob(
  actorStore: ActorStore,
  boundaryResolver: BoundaryResolver,
) {
  const bloomManager = new BloomManager()
  const blobAuth = new BlobAuthServiceImpl(actorStore, boundaryResolver)
  return { blobAuth, bloomManager }
}
