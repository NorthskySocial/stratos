import { AuthRequiredError } from '@atproto/xrpc-server'
import {
  spaceUriToBoundary,
  type BoundaryCatalogStore,
} from '@northskysocial/stratos-core'
import type { SpaceCredentialResult } from '../../infra/auth/space-credential-verifier.js'

export async function requireActiveSpaceCredential(
  store: BoundaryCatalogStore,
  serviceDid: string,
  credential: SpaceCredentialResult,
): Promise<void> {
  const parsed = spaceUriToBoundary(credential.spaceUri, serviceDid)
  const definition = parsed.ok ? await store.get(parsed.value) : null
  // Legacy credentials only remain valid while the imported definition is unchanged.
  if (
    definition?.status !== 'active' ||
    (credential.boundaryRevision ?? 1) !== definition.revision
  ) {
    throw new AuthRequiredError('Authorization failed')
  }
}
