import {
  type BoundaryResolver,
  type Cache,
  type EnrollmentStoreReader,
  type Logger,
} from '@northskysocial/stratos-core'
import type { AccountTakedownLog } from '../../subscription/takedown-filter.js'
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
 * @param takedownLog - Label log that decides account takedowns
 * @param cache - Optional cache for boundary resolution
 * @param logger - Optional logger for invariant reporting
 * @returns Hydration context
 */
export function initHydration(
  actorStore: ActorStore,
  enrollmentStore: EnrollmentStoreReader,
  takedownLog: AccountTakedownLog,
  cache?: Cache,
  logger?: Logger,
): HydrationContext {
  let boundaryResolver: BoundaryResolver = new EnrollmentBoundaryResolver(
    enrollmentStore,
  )
  if (cache) {
    boundaryResolver = new CachedBoundaryResolver(boundaryResolver, cache)
  }

  const recordResolver = new ActorStoreRecordResolver(actorStore, takedownLog)
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
