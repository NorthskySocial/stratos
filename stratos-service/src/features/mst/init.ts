import { type Keypair } from '@atproto/crypto'
import {
  type SigningService,
  type SequencingService,
} from '@northskysocial/stratos-core'
import { type ActorTransactor } from '../../actor-store-types.js'
import { type SequenceTrace } from '../../api/index.js'
import {
  SignFnSigningService,
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
 * @param signingKey - Service Keypair used only for the default signing service
 *   exposed on the context (per-actor writes bind their own signer at the call
 *   site). Service-key handling is out of scope for the actor-signer seam.
 * @returns MST context
 */
export function initMst(signingKey: Keypair): MstContext {
  const signingService = new SignFnSigningService((bytes) =>
    signingKey.sign(bytes),
  )

  return {
    signingService,
    sequencingServiceFactory: (store, trace) =>
      new ActorStoreSequencingService(store, trace),
  }
}
