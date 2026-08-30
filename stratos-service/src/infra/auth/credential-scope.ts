import { AuthRequiredError } from '@atproto/xrpc-server'
import { spaceUriToBoundary } from '@northskysocial/stratos-core'
import type { AppContext } from '../../context-types.js'
import type { HandlerAuth } from '../../api/types.js'

/**
 * Space-credential request scope.
 *
 * When a read/sync request authenticates with a space credential for space S,
 * the request's effective visibility is the "members-of-S view": we reuse the
 * EXISTING per-record boundary gate by treating the caller as enrolled in
 * EXACTLY the singleton `{boundary(S)}`. This composes with — never replaces —
 * the gate: a record whose (single) domain is not `boundary(S)` has an empty
 * intersection and is filtered out (fail closed).
 *
 * The synthetic viewer DID {@link CREDENTIAL_VIEWER_DID} is deliberately NOT a
 * resolvable/ownable DID, so the gate's owner short-circuit
 * (`viewerDid === ownerDid`) can never fire for a credential caller — access is
 * decided purely by boundary intersection.
 */
export interface CredentialScope {
  /**
   * A non-null, non-ownable synthetic viewer DID. Keeps the boundary gate on
   * its intersection path (never the owner short-circuit, never the
   * unauthenticated `null` short-circuit).
   */
  viewerDid: string
  /** The singleton viewer-boundary set: exactly `{boundary(S)}`. */
  viewerDomains: string[]
  /** The admitted space URI (for logging). */
  spaceUri: string
}

/**
 * Synthetic viewer DID used for space-credential requests. Intentionally not a
 * real, resolvable DID: it can never equal a record owner's DID, so the
 * boundary gate's owner short-circuit is unreachable for credential callers.
 */
export const CREDENTIAL_VIEWER_DID = 'did:internal:space-credential'

/**
 * Whether the given auth credentials are a space credential.
 *
 * @param auth - Handler auth context.
 * @returns True when the caller authenticated with a space credential.
 */
export function isSpaceCredentialAuth(auth: HandlerAuth | undefined): boolean {
  return auth?.credentials?.type === 'space-credential'
}

/**
 * Resolve the {@link CredentialScope} for a space-credential request, mapping
 * the admitted space URI to its Stratos boundary via
 * {@link spaceUriToBoundary} and injecting it as the singleton viewer-boundary
 * set.
 *
 * @param auth - Handler auth context (must be a verified space credential).
 * @param serviceDid - This service's DID (to map the space URI to a boundary).
 * @returns The credential scope, or `null` when the auth is not a space
 *   credential.
 * @throws AuthRequiredError if a space-credential auth carries no / an
 *   un-mappable space URI (fail closed — a verified credential always should).
 */
export function resolveCredentialScope(
  auth: HandlerAuth | undefined,
  serviceDid: string,
): CredentialScope | null {
  if (!isSpaceCredentialAuth(auth)) return null
  const spaceUri = auth?.credentials?.spaceUri
  if (!spaceUri) {
    throw new AuthRequiredError('Space credential missing space URI')
  }
  const boundary = spaceUriToBoundary(spaceUri, serviceDid)
  if (!boundary.ok) {
    // A verified credential's sub already targets our service DID, so this is
    // not reachable in practice; fail closed rather than widen access.
    throw new AuthRequiredError('Space credential targets an unknown space')
  }
  return {
    viewerDid: CREDENTIAL_VIEWER_DID,
    viewerDomains: [boundary.value],
    spaceUri,
  }
}

/**
 * Resolve the calling service's DID from service-auth credentials.
 * @param auth - Handler auth context.
 * @returns The caller service DID.
 * @throws AuthRequiredError when the credential is not valid service auth.
 */
export function requireServiceCaller(auth: HandlerAuth | undefined): string {
  const creds = auth?.credentials as
    | { type?: string; did?: string; iss?: string }
    | undefined
  if (creds?.type !== 'service') {
    throw new AuthRequiredError('Service auth required')
  }
  const callerDid = creds.iss ?? creds.did
  if (!callerDid) {
    throw new AuthRequiredError('Service auth required')
  }
  return callerDid
}

/**
 * Resolve the caller's enrolled boundaries, failing closed on any error or an
 * empty set. A caller with no enrolled boundaries can observe nothing.
 * @param ctx - Application context.
 * @param callerDid - The calling service DID.
 * @returns The caller's boundary set.
 * @throws AuthRequiredError when the caller is enrolled in no boundary.
 */
async function resolveCallerBoundaries(
  ctx: AppContext,
  callerDid: string,
): Promise<ReadonlySet<string>> {
  let boundaries: string[]
  try {
    boundaries = await ctx.enrollmentStore.getBoundaries(callerDid)
  } catch (err) {
    // Fail closed: a scope-resolution error must never widen access.
    ctx.logger?.warn({ callerDid, err }, 'boundary resolution failed')
    throw new AuthRequiredError('Service is not enrolled in any boundary')
  }
  if (boundaries.length === 0) {
    throw new AuthRequiredError('Service is not enrolled in any boundary')
  }
  return new Set(boundaries)
}

/**
 * Resolve the effective boundary set for a `serviceOrSpaceCredential`
 * request, accepting EITHER inter-service auth OR a space credential. A space
 * credential for space S yields the singleton `{boundary(S)}`, so a caller
 * holding one is admitted to S only.
 *
 * Shared by every endpoint bound to `authVerifier.serviceOrSpaceCredential`
 * (pull-sync, space membership) so the admission rule lives in one place.
 *
 * @param ctx - Application context.
 * @param auth - Handler auth context.
 * @returns The caller's boundary set.
 * @throws AuthRequiredError when neither auth path resolves a usable scope.
 */
export async function resolveEffectiveBoundaries(
  ctx: AppContext,
  auth: HandlerAuth | undefined,
): Promise<ReadonlySet<string>> {
  const credentialScope = resolveCredentialScope(auth, ctx.serviceDid)
  if (credentialScope) {
    return new Set(credentialScope.viewerDomains)
  }
  const callerDid = requireServiceCaller(auth)
  return resolveCallerBoundaries(ctx, callerDid)
}
