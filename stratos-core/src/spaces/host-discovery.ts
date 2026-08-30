/**
 * Repo-host discovery for permissioned spaces.
 *
 * Upstream has no answer to "which host holds this member's repo":
 * `com.atproto.space.listRepos` returns only `{did, rev, hash}`, and no space
 * lexicon or table carries a host field. Stratos sets its own convention:
 *
 *   1. An authority-recorded override, if Stratos holds one for this member.
 *   2. Otherwise the `#atproto_pds` service endpoint in the member's DID
 *      document.
 *
 * The override exists so an operator can correct a member whose repo does not
 * live on the PDS named in their DID document.
 *
 * This module is pure: both dependencies are injected ports, so resolution is
 * unit-testable without network access. Prototype:
 * `test/spike/spaces/a4-host-discovery.ts`.
 */

/**
 * How a repo host was determined. Surfaced by MM-08 so an operator debugging
 * a bad route can see which arm answered.
 */
export type HostSource = 'authority-override' | 'did-document'

/** A resolved repo host, with the arm of the convention that produced it. */
export interface ResolvedRepoHost {
  host: string
  source: HostSource
}

/** Reads a Stratos-recorded host override for a member of a space. */
export interface HostOverrideReader {
  get(spaceUri: string, memberDid: string): Promise<string | undefined>
}

/** Resolves the DID document `#atproto_pds` service endpoint for a member. */
export interface DidPdsReader {
  getPdsEndpoint(memberDid: string): Promise<string | undefined>
}

/** Dependencies {@link resolveRepoHost} needs, both injected ports. */
export interface RepoHostResolverDeps {
  overrides: HostOverrideReader
  dids: DidPdsReader
}

/**
 * A member whose host lookup fails must never halt a sync pass. This helper
 * enforces that once, for every injected reader.
 */
async function settleToUndefined<T>(
  lookup: () => Promise<T | undefined>,
): Promise<T | undefined> {
  try {
    return await lookup()
  } catch {
    return undefined
  }
}

/**
 * Resolve the repo host for one member of one space.
 *
 * The override wins over the DID document. An unresolvable member (no
 * override, no DID-document PDS endpoint, or either lookup failing) returns
 * `undefined` -- it never throws.
 */
export async function resolveRepoHost(
  spaceUri: string,
  memberDid: string,
  deps: RepoHostResolverDeps,
): Promise<ResolvedRepoHost | undefined> {
  const override = await settleToUndefined(() =>
    deps.overrides.get(spaceUri, memberDid),
  )
  if (override) return { host: override, source: 'authority-override' }

  const endpoint = await settleToUndefined(() =>
    deps.dids.getPdsEndpoint(memberDid),
  )
  if (endpoint) return { host: endpoint, source: 'did-document' }

  return undefined
}
