import {
  type BoundaryResolver,
  type Cache,
  type EnrollmentStoreReader,
  type Logger,
} from '@northskysocial/stratos-core'
import {
  CachedBoundaryResolver,
  EnrollmentBoundaryResolver,
} from '../enrollment'
import { type HydrationContext } from '../../context-types.js'
import { ActorStoreRecordResolver, HydrationServiceImpl } from './adapter.js'
import { type ActorStore } from '../../actor-store-types.js'

/**
 * Initialize hydration context
 * @param actorStore - Actor store
 * @param enrollmentStore - Enrollment store reader
 * @param cache - Optional cache for boundary resolution
 * @param logger - Optional logger for invariant reporting
 * @returns Hydration context
 */
export function initHydration(
  actorStore: ActorStore,
  enrollmentStore: EnrollmentStoreReader,
  cache?: Cache,
  logger?: Logger,
): HydrationContext {
  let boundaryResolver: BoundaryResolver = new EnrollmentBoundaryResolver(
    enrollmentStore,
  )
  if (cache) {
    boundaryResolver = new CachedBoundaryResolver(boundaryResolver, cache)
  }

  const recordResolver = new ActorStoreRecordResolver(actorStore)
  const hydrationService = new HydrationServiceImpl(
    recordResolver,
    boundaryResolver,
    logger,
  )

  return {
    boundaryResolver,
    hydrationService,
  }
}
