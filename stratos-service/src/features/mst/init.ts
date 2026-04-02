import { type Keypair } from '@atproto/crypto'
import {
  type SigningService,
  type SequencingService,
} from '@northskysocial/stratos-core'
import { type ActorTransactor } from '../../actor-store-types.js'
import { type SequenceTrace } from '../../api/index.js'
import {
  KeypairSigningService,
  ActorStoreSequencingService,
} from './internal/adapters.js'

export interface MstContext {
  signingService: SigningService
  sequencingServiceFactory: (
    store: ActorTransactor,
    trace?: SequenceTrace,
  ) => SequencingService
}

/**
 * Initialize MST context
 * @param signingKey - Keypair for signing commits
 * @returns MST context
 */
export function initMst(signingKey: Keypair): MstContext {
  const signingService = new KeypairSigningService(signingKey)

  return {
    signingService,
    sequencingServiceFactory: (store, trace) =>
      new ActorStoreSequencingService(store, trace),
  }
}
