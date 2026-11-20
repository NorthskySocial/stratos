import { ScopePermissions } from '@atproto/oauth-scopes'
import type { OAuthSession } from '@atproto/oauth-client-node'
import type { Logger, SpacesCapability } from '@northskysocial/stratos-core'
import { HOSTED_SPACE_COLLECTIONS } from '../shared/space-type-registry.js'
import { SPACE_TYPE } from './client.js'

// The scope library types an authority as a DID. The value is passed through
// unchanged: a malformed one simply matches no grant, as before. The same
// holds for the collection.
function spaceOf(serviceDid: string) {
  return {
    spaceType: SPACE_TYPE,
    authority: serviceDid as `did:${string}:${string}`,
    skey: '*',
  } as const
}

/**
 * Whether a granted scope lets the member create records of one collection in
 * this authority's space type, in any boundary.
 */
export function grantAllowsCreate(
  scope: string,
  collection: string,
  serviceDid: string,
): boolean {
  return new ScopePermissions(scope).allowsSpace(spaceOf(serviceDid), {
    action: 'create',
    collection: collection as `${string}.${string}.${string}`,
  })
}

/**
 * Whether a granted scope carries a read grant, or a create grant on a hosted
 * collection, in this authority's space type. A scope without one was never
 * issued a space grant at all, as when the member's PDS does not support spaces.
 */
export function holdsSpaceGrant(scope: string, serviceDid: string): boolean {
  const permissions = new ScopePermissions(scope)
  return (
    permissions.allowsSpace(spaceOf(serviceDid), { action: 'read' }) ||
    HOSTED_SPACE_COLLECTIONS.some((collection) =>
      grantAllowsCreate(scope, collection, serviceDid),
    )
  )
}

/**
 * Enrollment always requests this authority's space scope. A missing grant
 * cannot distinguish an unsupported PDS from withheld consent, so it leaves
 * capability unknown. Reauthorization must never move custody on that basis.
 */
export async function detectSpacesCapability(
  session: OAuthSession,
  serviceDid: string,
  logger?: Logger,
): Promise<SpacesCapability> {
  try {
    const { scope } = await session.getTokenInfo(false)
    // RFC 6749 lets a server omit `scope` when the grant equals the request,
    // and the wire schema marks it optional even though the type does not.
    // An unreadable scope is "could not determine", not "not capable".
    if (typeof scope !== 'string' || scope.length === 0) {
      logger?.warn(
        { did: session.sub },
        'token response carried no scope, cannot decide spaces capability',
      )
      return 'unknown'
    }
    const permissions = new ScopePermissions(scope)
    // Check create as well as read. Custody decides where this user's records
    // are written, so a grant that reads but cannot create is not capable of
    // the flow we would put them in.
    const canRead = permissions.allowsSpace(spaceOf(serviceDid), {
      action: 'read',
    })
    const canCreate = HOSTED_SPACE_COLLECTIONS.every((collection) =>
      grantAllowsCreate(scope, collection, serviceDid),
    )
    if (canRead && canCreate) return 'capable'
  } catch (err) {
    logger?.warn(
      {
        did: session.sub,
        err: err instanceof Error ? err.message : String(err),
      },
      'failed to read granted OAuth scope for spaces capability check',
    )
    return 'unknown'
  }

  logger?.warn(
    { did: session.sub },
    'requested space scope was not granted, cannot decide spaces capability',
  )
  return 'unknown'
}
