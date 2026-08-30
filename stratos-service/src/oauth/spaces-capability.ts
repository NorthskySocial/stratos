import { ScopePermissions } from '@atproto/oauth-scopes'
import type { OAuthSession } from '@atproto/oauth-client-node'
import type { Logger, SpacesCapability } from '@northskysocial/stratos-core'
import { SPACE_COLLECTION, SPACE_TYPE } from './client.js'

/**
 * Decides whether the enrolling user's PDS supports spaces, from the OAuth
 * scope it actually granted. `buildSpaceScope` always requests the space
 * scope; a PDS that does not understand `space:` scopes silently drops the
 * request and the token comes back with only the base scope granted, so the
 * absence of the grant is itself the "not capable" signal — no PDS probe is
 * needed.
 *
 * A failure to read the granted scope is reported as `'unknown'`, never
 * `'not-capable'`: this must never let a transient error downgrade a
 * spaces-capable PDS to Stratos custody.
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
    return canRead && canCreate ? 'capable' : 'not-capable'
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
}
