import { ScopePermissions } from '@atproto/oauth-scopes'
import type { OAuthSession } from '@atproto/oauth-client-node'
import type { Logger, SpacesCapability } from '@northskysocial/stratos-core'
import { SPACE_TYPE } from './client.js'

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
    const granted = new ScopePermissions(scope).allowsSpace({
      type: SPACE_TYPE,
      authority: serviceDid,
      skey: '*',
      action: 'read',
    })
    return granted ? 'capable' : 'not-capable'
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
