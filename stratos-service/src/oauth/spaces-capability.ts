import { ScopePermissions } from '@atproto/oauth-scopes'
import type { OAuthSession } from '@atproto/oauth-client-node'
import type { Logger, SpacesCapability } from '@northskysocial/stratos-core'
import { SPACE_COLLECTION, SPACE_TYPE } from './client.js'

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
    const space = { type: SPACE_TYPE, authority: serviceDid, skey: '*' }
    // Check create as well as read. Custody decides where this user's records
    // are written, so a grant that reads but cannot create is not capable of
    // the flow we would put them in.
    const canRead = permissions.allowsSpace({ ...space, action: 'read' })
    const canCreate = permissions.allowsSpace({
      ...space,
      collection: SPACE_COLLECTION,
      action: 'create',
    })
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
