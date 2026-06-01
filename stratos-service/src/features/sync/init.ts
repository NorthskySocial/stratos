import type { BoundaryResolver } from '@northskysocial/stratos-core'
import type { ActorStore } from '../../actor-store-types.js'
import type { BloomManager } from '../blob/bloom-manager.js'
import { SyncServiceImpl, type SyncService } from './adapter.js'

/**
 * Sync context for Stratos service
 */
export interface SyncContext {
  syncService: SyncService
}

/**
 * Initialize the sync context
 * @param actorStore - Actor store
 * @param bloomManager - Bloom manager
 * @param boundaryResolver - Boundary resolver
 * @returns Initialized sync context
 */
export function initSync(
  actorStore: ActorStore,
  bloomManager: BloomManager,
  boundaryResolver: BoundaryResolver,
): SyncContext {
  const syncService = new SyncServiceImpl(
    actorStore,
    bloomManager,
    boundaryResolver,
  )

  return {
    syncService,
  }
}
