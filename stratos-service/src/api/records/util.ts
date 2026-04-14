import type { Logger } from '@northskysocial/stratos-core'
import { ActorRepoManager } from '@northskysocial/stratos-core'
import type { ActorStore, ActorTransactor } from '../../actor-store-types.js'
import type { Keypair } from '@atproto/crypto'
import type { SequenceTrace } from './types.js'
import {
  ActorStoreSequencingService,
  KeypairSigningService,
} from '../../features/mst/internal/adapters.js'

// WARNING: Do NOT pass store.repo.db to ActorRepoManager. The manager must
// receive the full repo transactor (store.repo) at the applyWrites() callsite
// so MST operations go through the LRU block cache. Passing a raw db handle
// creates a fresh empty cache per write, causing unnecessary queries and
// connection pool exhaustion under load.
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
  return new ActorRepoManager(signingService, sequencingService, logger)
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
