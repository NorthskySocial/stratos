import type { BoundaryResolver, Logger } from '@northskysocial/stratos-core'
import type { ActorStore } from '../../actor-store-types.js'
import type { AccountTakedownLog } from '../../subscription/takedown-filter.js'
import { BlobAuthServiceImpl } from './adapter.js'

/**
 * Initialize blob support.
 * @param actorStore - Store for actor repositories.
 * @param boundaryResolver - Resolver for viewer boundaries.
 * @param takedownLog - Label log that decides account takedowns.
 * @param logger - Optional logger for invariant reporting.
 * @returns Initialized blob authentication service.
 */
export function initBlob(
  actorStore: ActorStore,
  boundaryResolver: BoundaryResolver,
  takedownLog: AccountTakedownLog,
  logger?: Logger,
) {
  const blobAuth = new BlobAuthServiceImpl(
    actorStore,
    boundaryResolver,
    takedownLog,
    logger,
  )
  return { blobAuth }
}
