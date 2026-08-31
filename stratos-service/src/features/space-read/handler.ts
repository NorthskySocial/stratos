import {
  AuthRequiredError,
  InvalidRequestError,
  Server as XrpcServer,
} from '@atproto/xrpc-server'
import { AtUri as AtUriSyntax } from '@atproto/syntax'
import {
  resolveRepoHost,
  spaceUriToBoundary,
  StratosValidator,
  type Custody,
  type StoredEnrollment,
} from '@northskysocial/stratos-core'
import type { AppContext } from '../../context-types.js'
import type { HandlerAuth, XrpcServerInternal } from '../../api/types.js'
import { createXrpcHandler } from '../../api/util.js'
import {
  isSpaceCredentialAuth,
  resolveEffectiveBoundaries,
} from '../../infra/auth/credential-scope.js'
import { createRepoHostResolverDeps } from './host-resolution.js'

/**
 * XRPC method NSID for the space-scoped record read. Spec-shaped mirror of
 * `com.atproto.space.getRecord` (atproto#5187), quarantined under the
 * `zone.stratos.*` namespace until the spec is finalized.
 */
export const GET_SPACE_RECORD_METHOD = 'zone.stratos.space.getRecord'

/**
 * XRPC method NSID for the space-scoped blob enumeration. Spec-shaped mirror
 * of `com.atproto.space.listBlobs` (atproto#5187), quarantined under the
 * `zone.stratos.*` namespace until the spec is finalized.
 */
export const LIST_SPACE_BLOBS_METHOD = 'zone.stratos.space.listBlobs'

/**
 * XRPC method NSID for the space membership oracle. Spec-shaped mirror of
 * `com.atproto.space.listRepos` (atproto#5187), extended with `host` /
 * `hostSource` per Stratos's own repo-host-discovery convention.
 */
export const LIST_SPACE_REPOS_METHOD = 'zone.stratos.space.listRepos'

interface GetSpaceRecordParams {
  space?: string
  repo?: string
  collection?: string
  rkey?: string
}

interface ListSpaceBlobsParams {
  space?: string
  repo?: string
  since?: string
  limit?: unknown
  cursor?: string
}

interface ListSpaceReposParams {
  space?: string
  limit?: unknown
  cursor?: string
}

interface RepoEntry {
  did: string
  custody: Custody
  rev?: string
  host?: string
  hostSource?: 'authority-override' | 'did-document'
}

/**
 * Register the `zone.stratos.space.getRecord` handler.
 *
 * Auth binding: `standardOrSpaceCredential` — a member reads with their user
 * session, a syncing service reads with a space credential. Both paths are
 * admitted to exactly ONE space per request, and the record must belong to it.
 *
 * @param server - XRPC server.
 * @param ctx - Application context.
 */
export function registerSpaceReadHandlers(
  server: XrpcServer,
  ctx: AppContext,
): void {
  const xrpc = server as unknown as XrpcServerInternal

  xrpc.method(GET_SPACE_RECORD_METHOD, {
    type: 'query',
    auth: ctx.authVerifier.standardOrSpaceCredential,
    handler: createXrpcHandler<unknown, GetSpaceRecordParams>(
      ctx,
      GET_SPACE_RECORD_METHOD,
      {
        // Identity is resolved explicitly below: a space-credential caller
        // legitimately has no `did`.
        requireAuth: false,
        handler: async ({ params, auth }) => {
          return handleGetSpaceRecord(ctx, params, auth)
        },
      },
    ),
  })

  xrpc.method(LIST_SPACE_BLOBS_METHOD, {
    type: 'query',
    auth: ctx.authVerifier.standardOrSpaceCredential,
    handler: createXrpcHandler<unknown, ListSpaceBlobsParams>(
      ctx,
      LIST_SPACE_BLOBS_METHOD,
      {
        requireAuth: false,
        handler: async ({ params, auth }) => {
          return handleListSpaceBlobs(ctx, params, auth)
        },
      },
    ),
  })

  // Auth binding: `serviceOrSpaceCredential`, not `standardOrSpaceCredential`
  // -- this is a membership oracle for syncing services, never a member's own
  // user session. A member reads their own boundary; this endpoint enumerates
  // OTHER members, which a user session must never be admitted to do.
  xrpc.method(LIST_SPACE_REPOS_METHOD, {
    type: 'query',
    auth: ctx.authVerifier.serviceOrSpaceCredential,
    handler: createXrpcHandler<unknown, ListSpaceReposParams>(
      ctx,
      LIST_SPACE_REPOS_METHOD,
      {
        requireAuth: false,
        handler: async ({ params, auth }) => {
          return handleListSpaceRepos(ctx, params, auth)
        },
      },
    ),
  })
}

/**
 * Parse a space URI and derive its Stratos boundary (fail closed).
 *
 * @param ctx - Application context.
 * @param space - The requested space URI.
 * @returns The space's Stratos boundary.
 * @throws InvalidRequestError `UnknownSpace` when the URI is malformed or
 *   targets another service.
 */
function resolveSpaceBoundary(ctx: AppContext, space: string): string {
  const boundary = spaceUriToBoundary(space, ctx.serviceDid)
  if (!boundary.ok) {
    throw new InvalidRequestError(
      'Unknown space: URI must target this service',
      'UnknownSpace',
    )
  }
  return boundary.value
}

/** A space read hides records outside the requested space to avoid existence leaks. */
async function handleGetSpaceRecord(
  ctx: AppContext,
  params: GetSpaceRecordParams,
  auth: HandlerAuth | undefined,
): Promise<{ uri: string; cid: string; value: unknown }> {
  const { space, repo, collection, rkey } = params
  if (!space || !repo || !collection || !rkey) {
    throw new InvalidRequestError(
      'space, repo, collection, and rkey are required',
      'InvalidRequest',
    )
  }

  const boundary = resolveSpaceBoundary(ctx, space)
  await assertAdmitted(ctx, space, boundary, auth)

  const exists = await ctx.actorStore.exists(repo)
  if (!exists) {
    throw new InvalidRequestError('Record not found', 'RecordNotFound')
  }

  const uri = `at://${repo}/${collection}/${rkey}`
  return await ctx.actorStore.read(repo, async (store) => {
    const record = await store.record.getRecord(new AtUriSyntax(uri), null)
    if (!record?.value) {
      throw new InvalidRequestError('Record not found', 'RecordNotFound')
    }
    // The record must belong to the requested space. Unlike the generic
    // repo read (where a domainless record is public), a space read FAILS
    // CLOSED on records outside the space — domainless records included.
    const domains = StratosValidator.extractBoundaryDomains(record.value)
    if (!domains.includes(boundary)) {
      throw new InvalidRequestError('Record not found', 'RecordNotFound')
    }
    return { uri, cid: record.cid, value: record.value }
  })
}

async function handleListSpaceBlobs(
  ctx: AppContext,
  params: ListSpaceBlobsParams,
  auth: HandlerAuth | undefined,
): Promise<{ cids: string[]; cursor?: string }> {
  const { space, repo, since, cursor } = params
  if (!space || !repo) {
    throw new InvalidRequestError(
      'space and repo are required',
      'InvalidRequest',
    )
  }
  const limit = parseLimit(params.limit, 500)

  const boundary = resolveSpaceBoundary(ctx, space)
  await assertAdmitted(ctx, space, boundary, auth)

  const exists = await ctx.actorStore.exists(repo)
  if (!exists) {
    throw new InvalidRequestError('Could not find repo', 'RepoNotFound')
  }

  const cids = await ctx.actorStore.read(repo, async (store) => {
    return store.blob.listBlobsForBoundary({ boundary, since, cursor, limit })
  })

  return {
    cids,
    ...(cids.length === limit ? { cursor: cids[cids.length - 1] } : {}),
  }
}

/**
 * Parse and clamp `limit` to the lexicon-declared range 1..1000.
 *
 * The lexicon declares `limit` as an integer, but params reach the handler
 * without schema validation, so the raw query value can be a string or not an
 * integer at all.
 *
 * @param raw - The raw `limit` param.
 * @param defaultLimit - The lexicon-declared default for this endpoint.
 * @returns The clamped integer limit.
 * @throws InvalidRequestError when the value is not an integer.
 */
function parseLimit(raw: unknown, defaultLimit: number): number {
  if (raw === undefined) return defaultLimit
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^-?\d+$/.test(raw)
        ? Number(raw)
        : NaN
  if (!Number.isInteger(value)) {
    throw new InvalidRequestError('limit must be an integer', 'InvalidRequest')
  }
  return Math.min(Math.max(value, 1), 1000)
}

/**
 * Core logic for {@link LIST_SPACE_REPOS_METHOD}.
 *
 * This is a membership oracle, not a member-facing read: admission is
 * `serviceOrSpaceCredential` only (see {@link resolveEffectiveBoundaries}),
 * never a plain user session. Membership is derived from active enrollment +
 * boundary -- there is no second, independently-maintained member list.
 */
async function handleListSpaceRepos(
  ctx: AppContext,
  params: ListSpaceReposParams,
  auth: HandlerAuth | undefined,
): Promise<{ repos: RepoEntry[]; cursor?: string }> {
  const { space } = params
  if (!space) {
    throw new InvalidRequestError('space is required', 'InvalidRequest')
  }

  const boundary = resolveSpaceBoundary(ctx, space)

  const callerBoundaries = await resolveEffectiveBoundaries(ctx, auth)
  if (!callerBoundaries.has(boundary)) {
    throw new AuthRequiredError('Not admitted to this space', 'AuthRequired')
  }

  const limit = parseLimit(params.limit, 100)
  const members = await ctx.enrollmentStore.listEnrollmentsByBoundary(
    boundary,
    { limit, cursor: params.cursor },
  )

  const repos = await buildRepoEntries(ctx, space, members)

  return {
    repos,
    ...(members.length === limit
      ? { cursor: members[members.length - 1].did }
      : {}),
  }
}

/** Caps concurrent per-member host/rev lookups fanned out from one page. */
const MAX_CONCURRENT_REPO_LOOKUPS = 10

/**
 * Resolve every member's repo entry, bounded to
 * {@link MAX_CONCURRENT_REPO_LOOKUPS} in flight at once -- a page can hold up
 * to 1000 members, and each entry does a DID resolution and/or an actor-store
 * read, so an unbounded fan-out can exhaust the admin connection pool.
 */
async function buildRepoEntries(
  ctx: AppContext,
  space: string,
  members: StoredEnrollment[],
): Promise<RepoEntry[]> {
  const entries = new Array<RepoEntry>(members.length)
  const hostResolutionFailures: RepoHostResolutionFailure[] = []
  const revFailures: RevLookupFailure[] = []
  let nextIndex = 0

  async function worker(): Promise<void> {
    for (let index = nextIndex++; index < members.length; index = nextIndex++) {
      entries[index] = await buildRepoEntry(
        ctx,
        space,
        members[index],
        hostResolutionFailures,
        revFailures,
      )
    }
  }

  const workerCount = Math.min(MAX_CONCURRENT_REPO_LOOKUPS, members.length)
  await Promise.all(Array.from({ length: workerCount }, worker))

  if (hostResolutionFailures.length > 0) {
    ctx.logger?.warn(
      {
        space,
        failedCount: hostResolutionFailures.length,
        sample: hostResolutionFailures.slice(0, 5),
      },
      'listRepos: repo host lookup failed for some members',
    )
  }

  // One aggregated line per page. A storage outage must not emit one warn
  // per member -- a full page is up to 1000 members.
  if (revFailures.length > 0) {
    ctx.logger?.warn(
      { failedCount: revFailures.length, sample: revFailures.slice(0, 5) },
      'listRepos: rev lookup failed for some members',
    )
  }
  return entries
}

/** One failed rev lookup, collected for the per-page aggregated warn. */
interface RevLookupFailure {
  did: string
  error: string
}

interface RepoHostResolutionFailure {
  did: string
}

/**
 * Build one {@link RepoEntry}: resolve the member's repo host (absent on a
 * miss, never fails the whole call) and Stratos-known rev.
 */
async function buildRepoEntry(
  ctx: AppContext,
  space: string,
  member: StoredEnrollment,
  hostResolutionFailures: RepoHostResolutionFailure[],
  revFailures: RevLookupFailure[],
): Promise<RepoEntry> {
  const custody = member.custody ?? 'stratos'
  const [resolvedHost, rev] = await Promise.all([
    custody === 'pds'
      ? resolveRepoHost(
          space,
          member.did,
          createRepoHostResolverDeps(ctx.idResolver, member.repoHost),
        )
      : undefined,
    getStratosRev(ctx, member, revFailures),
  ])
  if (!resolvedHost) {
    hostResolutionFailures.push({ did: member.did })
  }
  return {
    did: member.did,
    custody,
    ...(rev ? { rev } : {}),
    ...(resolvedHost
      ? { host: resolvedHost.host, hostSource: resolvedHost.source }
      : {}),
  }
}

/**
 * The repo revision Stratos itself has for a member -- meaningful only for a
 * stratos-custody member, whose repo Stratos stores. A pds-custody member's
 * repo lives on their own PDS; Stratos never learns its rev. Never throws:
 * an actor-store failure degrades to an absent rev instead of failing the
 * whole page, and is recorded in `revFailures` for the aggregated warn.
 */
async function getStratosRev(
  ctx: AppContext,
  member: StoredEnrollment,
  revFailures: RevLookupFailure[],
): Promise<string | undefined> {
  if (member.custody === 'pds') return undefined
  try {
    if (!(await ctx.actorStore.exists(member.did))) return undefined
    return await ctx.actorStore.read(member.did, async (store) => {
      const root = await store.repo.getRootDetailed()
      return root?.rev
    })
  } catch (err) {
    revFailures.push({
      did: member.did,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

/**
 * Assert the caller is admitted to the requested space (fail closed).
 *
 * @param ctx - Application context.
 * @param space - The requested space URI.
 * @param boundary - The space's Stratos boundary.
 * @param auth - Handler auth context.
 * @throws AuthRequiredError when not admitted.
 */
async function assertAdmitted(
  ctx: AppContext,
  space: string,
  boundary: string,
  auth: HandlerAuth | undefined,
): Promise<void> {
  // The custom error name matches the `AuthRequired` error that both space
  // lexicons declare; the library default is `AuthenticationRequired`.
  if (isSpaceCredentialAuth(auth)) {
    // A credential admits exactly its own space; anything else is refused
    // (the generic reason is deliberate — no cross-space probing).
    if (auth?.credentials?.spaceUri !== space) {
      throw new AuthRequiredError('Not admitted to this space', 'AuthRequired')
    }
    return
  }

  const userDid = auth?.credentials?.did
  if (!userDid) {
    throw new AuthRequiredError('Authentication required', 'AuthRequired')
  }
  // Live membership check (same freshness contract as credential issuance).
  const boundaries = await ctx.enrollmentStore.getBoundaries(userDid)
  if (!boundaries.includes(boundary)) {
    throw new AuthRequiredError('Not admitted to this space', 'AuthRequired')
  }
}
