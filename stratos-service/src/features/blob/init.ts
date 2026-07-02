import type { BoundaryResolver, Logger } from '@northskysocial/stratos-core'
import type { ActorStore } from '../../actor-store-types.js'
import { BlobAuthServiceImpl } from './adapter.js'
import { BloomManager } from './bloom-manager.js'

/**
 * Initialize blob support.
 * @param actorStore - Store for actor repositories.
 * @param boundaryResolver - Resolver for viewer boundaries.
 * @param logger - Optional logger for invariant reporting.
 * @returns Initialized blob authentication service and BloomManager.
 */
export function initBlob(
  actorStore: ActorStore,
  boundaryResolver: BoundaryResolver,
  logger?: Logger,
) {
  const bloomManager = new BloomManager()
  const blobAuth = new BlobAuthServiceImpl(actorStore, boundaryResolver, logger)
  return { blobAuth, bloomManager }
}
