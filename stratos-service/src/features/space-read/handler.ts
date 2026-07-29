import {
  AuthRequiredError,
  InvalidRequestError,
  Server as XrpcServer,
} from '@atproto/xrpc-server'
import { AtUri as AtUriSyntax } from '@atproto/syntax'
import { parseSpaceUri, StratosValidator } from '@northskysocial/stratos-core'
import type { AppContext } from '../../context-types.js'
import type { HandlerAuth, XrpcServerInternal } from '../../api/types.js'
import { createXrpcHandler } from '../../api/util.js'
import { isSpaceCredentialAuth } from '../../infra/auth/credential-scope.js'

/**
 * XRPC method NSID for the space-scoped record read. Spec-shaped mirror of
 * `com.atproto.space.getRecord` (atproto#5187), quarantined under the
 * `zone.stratos.*` namespace until the spec is finalized.
 */
export const GET_SPACE_RECORD_METHOD = 'zone.stratos.space.getRecord'

interface GetSpaceRecordParams {
  space?: string
  repo?: string
  collection?: string
  rkey?: string
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
}

/**
 * Core logic for {@link GET_SPACE_RECORD_METHOD}.
 *
 * Steps:
 *   1. Require `space`, `repo`, `collection`, `rkey`.
 *   2. Parse `space`; its DID must equal our service DID → else `UnknownSpace`.
 *   3. Admission (one space per request, fail closed):
 *      - space credential: its admitted space must EQUAL the requested space;
 *      - user session: the user must be enrolled in the space's boundary
 *        (live enrollment-store lookup — revocation-fresh, no cache).
 *   4. Fetch the record; it must exist AND belong to the requested space.
 *      Records outside the space — including records with no space at all —
 *      resolve to `RecordNotFound` (no existence leak).
 */
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

  const parsed = parseSpaceUri(space)
  if (!parsed.ok || parsed.value.spaceDid !== ctx.serviceDid) {
    throw new InvalidRequestError(
      'Unknown space: URI must target this service',
      'UnknownSpace',
    )
  }
  const boundary = `${parsed.value.spaceDid}/${parsed.value.skey}`

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
  if (isSpaceCredentialAuth(auth)) {
    // A credential admits exactly its own space; anything else is refused
    // (the generic reason is deliberate — no cross-space probing).
    if (auth?.credentials?.spaceUri !== space) {
      throw new AuthRequiredError('Not admitted to this space')
    }
    return
  }

  const userDid = auth?.credentials?.did
  if (!userDid) {
    throw new AuthRequiredError('Authentication required')
  }
  // Live membership check (same freshness contract as credential issuance).
  const boundaries = await ctx.enrollmentStore.getBoundaries(userDid)
  if (!boundaries.includes(boundary)) {
    throw new AuthRequiredError('Not admitted to this space')
  }
}
