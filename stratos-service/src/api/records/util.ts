import type { Logger } from '@northskysocial/stratos-core'
import { ActorRepoManager } from '@northskysocial/stratos-core'
import type { ActorStore, ActorTransactor } from '../../actor-store-types.js'
import type { Keypair } from '@atproto/crypto'
import type { SequenceTrace } from './types.js'
import {
  ActorStoreSequencingService,
  KeypairSigningService,
} from '../../features/mst/internal/adapters.js'

/**
 * Helper to create an ActorRepoManager with standard signing and sequencing services
 *
 * @param logger - Logger instance
 * @param store - Actor transactor store
 * @param actorSigningKey - Private key for signing commits
 * @param sequenceTrace - Sequence trace for tracking commit sequencing
 * @returns ActorRepoManager instance
 */
export function createRepoManager(
  logger: Logger | undefined,
  store: ActorTransactor,
  actorSigningKey: Keypair,
  sequenceTrace: SequenceTrace,
): ActorRepoManager {
  const signingService = new KeypairSigningService(actorSigningKey)
  const sequencingService = new ActorStoreSequencingService(
    store,
    sequenceTrace,
  )
  return new ActorRepoManager(
    store.repo.db,
    signingService,
    sequencingService,
    logger,
  )
}

/**
 * Ensure actor store exists for the given DID
 * If it doesn't exist, it will be created'
 *
 * @param actorStore - Actor store instance
 * @param did - DID to check
 */
export async function ensureActorStoreExists(
  actorStore: ActorStore,
  did: string,
): Promise<void> {
  const exists = await actorStore.exists(did)
  if (!exists) {
    await actorStore.create(did)
  }
}
