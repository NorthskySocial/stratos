import { InvalidRequestError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import {
  grantAllowsCreate,
  holdsSpaceGrant,
} from '../../oauth/spaces-capability.js'

/**
 * Refuses a write to a collection the member's stored space grant never
 * covered, so a grant from before the collection existed sends the member to
 * authorize again. Only a scope that carries a space grant of this authority
 * can be out of date: a stratos-custody member's PDS usually drops the space
 * scope, and authorizing again would return the same scope. A member with no
 * stored session, or a scope that cannot be read, is not checked.
 * @throws InvalidRequestError `ScopeUpgradeRequired`
 */
export async function assertCollectionGranted(
  ctx: AppContext,
  callerDid: string,
  collection: string,
): Promise<void> {
  const session = await ctx.oauthStores.sessionStore.get(callerDid)
  // A stored row is parsed JSON, so its shape is not guaranteed by the type.
  const scope: unknown = session?.tokenSet?.scope
  if (typeof scope !== 'string') return
  if (!isOutOfDate(scope, collection, ctx.serviceDid)) return
  throw new InvalidRequestError(
    "The member's grant predates this collection. Authorize again.",
    'ScopeUpgradeRequired',
  )
}

function isOutOfDate(
  scope: string,
  collection: string,
  serviceDid: string,
): boolean {
  try {
    return (
      holdsSpaceGrant(scope, serviceDid) &&
      !grantAllowsCreate(scope, collection, serviceDid)
    )
  } catch {
    return false
  }
}
