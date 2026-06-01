import {
  type BoundaryResolver,
  type Cache,
  type EnrollmentStoreReader,
} from '@northskysocial/stratos-core'
import {
  CachedBoundaryResolver,
  EnrollmentBoundaryResolver,
} from '../enrollment'
import { type HydrationContext } from '../../context-types.js'
import { SyncServiceImpl } from '../sync'
import { ActorStoreRecordResolver, HydrationServiceImpl } from './adapter.js'
import { type ActorStore } from '../../actor-store-types.js'
import { type BloomManager } from '../blob'

/**
 * Initialize hydration context
 * @param actorStore - Actor store
 * @param enrollmentStore - Enrollment store reader
 * @param bloomManager - Bloom manager
 * @param cache - Optional cache for boundary resolution
 * @returns Hydration context
 */
export function initHydration(
  actorStore: ActorStore,
  enrollmentStore: EnrollmentStoreReader,
  bloomManager: BloomManager,
  cache?: Cache,
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
  )

  const syncService = new SyncServiceImpl(
    actorStore,
    bloomManager,
    boundaryResolver,
  )

  return {
    boundaryResolver,
    hydrationService,
    syncService,
  }
}
