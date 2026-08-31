import express, { type Request, type Response } from 'express'
import { Agent } from '@atproto/api'
import { ensureValidDid } from '@atproto/syntax'
import { InvalidRequestError, Server as XrpcServer } from '@atproto/xrpc-server'
import {
  boundaryToSpaceUri,
  type Enrollment,
  EnrollmentDeniedError,
  resolveRepoHost,
} from '@northskysocial/stratos-core'
import type { AppContext } from '../../context-types.js'
import { type XrpcServerInternal } from '../../api/types.js'
import { createXrpcHandler } from '../../api/util.js'
import { serviceDIDToRkey, SPACE_TYPE } from '../../oauth'
import { createRepoHostResolverDeps } from '../space-read/host-resolution.js'
import { verifyEnrolled } from './internal/auth.js'
import type { PdsSyncPageKey } from './internal/pds-sync-store.js'

const RESOLVE_CACHE_TTL_MS = 60 * 1000
const RESOLVE_CACHE_MAX_ENTRIES = 10_000

/**
 * Positive `resolveEnrollments` response cache, keyed by DID.
 *
 * Every handler that mutates enrollment or boundary state must call
 * `invalidate`, or a downstream reconcile that resolves within the TTL reads
 * stale `enrolled: true` state and purges nothing.
 *
 * An epoch fences the resolve handler's read-then-set window: every
 * invalidation bumps it and `set` writes only while the caller's epoch is
 * still current, so a resolution that started before an invalidation cannot
 * re-insert the stale boundary set it read. One counter for all DIDs keeps
 * the fence state constant-size; the cost is only a skipped cache insert
 * when an unrelated invalidation lands mid-resolve.
 *
 * Expired entries are evicted on read and the map is capped (oldest insert
 * evicted first), so the cache cannot grow for the life of the process.
 */
export class ResolveEnrollmentsCache {
  private readonly entries = new Map<
    string,
    { boundaries: string[]; expiresAt: number }
  >()
  private currentEpoch = 0

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  get(did: string): string[] | undefined {
    const entry = this.entries.get(did)
    if (!entry) return undefined
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(did)
      return undefined
    }
    return entry.boundaries
  }

  epoch(): number {
    return this.currentEpoch
  }

  set(did: string, boundaries: string[], epoch: number): void {
    if (epoch !== this.currentEpoch) return
    if (!this.entries.has(did) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(did, { boundaries, expiresAt: Date.now() + this.ttlMs })
  }

  invalidate(did: string): void {
    this.entries.delete(did)
    this.currentEpoch++
  }
}

/**
 * Register all enrollment-related XRPC handlers
 *
 * @param server - XRPC server
 * @param ctx - Application context
 */
export function registerEnrollmentHandlers(
  server: XrpcServer,
  ctx: AppContext,
): void {
  const resolveCache = new ResolveEnrollmentsCache(
    RESOLVE_CACHE_TTL_MS,
    RESOLVE_CACHE_MAX_ENTRIES,
  )
  registerEnrollmentStatus(server, ctx)
  registerEnrollmentUnenroll(server, ctx, resolveCache)
  registerResolveEnrollmentsHandler(ctx, resolveCache)
  registerAdminBoundaryHandlers(ctx, resolveCache)
  registerListEnrollmentsHandler(ctx)
  registerGetRepoHostHandler(ctx)
  registerListDomainsHandler(ctx)
  registerListPdsSyncStatusHandler(ctx)
  registerRequeuePdsSyncHandler(ctx)
}

/**
 * Register handler for enrollment status
 * @param server - XRPC server
 * @param ctx - Application context
 */
function registerEnrollmentStatus(server: XrpcServer, ctx: AppContext): void {
  const xrpc = server as unknown as XrpcServerInternal
  const { authVerifier } = ctx

  xrpc.method('zone.stratos.enrollment.status', {
    type: 'query',
    auth: authVerifier.optionalStandard,
    handler: createXrpcHandler(ctx, 'zone.stratos.enrollment.status', {
      requireAuth: false,
      handler: async ({ params, auth }) => {
        const did = params.did as string
        if (!did) {
          throw new InvalidRequestError(
            'did parameter required',
            'InvalidRequest',
          )
        }

        const enrollment = await ctx.enrollmentService.getEnrollment(did)
        if (!enrollment) {
          // Check if user is eligible for auto-enrollment
          try {
            await verifyEnrolled(did, {
              idResolver: ctx.idResolver,
              enrollmentStore: ctx.enrollmentStore,
              config: ctx.cfg.enrollment,
              allowListProvider: ctx.allowListProvider,
              logger: ctx.logger,
            })
            return { did, enrolled: false, eligible: true }
          } catch (err) {
            if (
              err instanceof EnrollmentDeniedError &&
              err.reason !== 'VerificationFailed'
            ) {
              return { did, enrolled: false, eligible: false }
            }
            // The check failed; omit eligible rather than claim a denial.
            return { did, enrolled: false }
          }
        }

        return buildEnrollmentStatusResponse(
          ctx,
          did,
          enrollment,
          auth?.credentials?.did,
        )
      },
    }),
  })
}

/**
 * Build enrollment status response
 * @param ctx - The application context
 * @param did - The decentralized identifier (DID) of the enrollment
 * @param enrollment - The enrollment record
 * @param authenticatedDid - The authenticated DID, if available
 * @returns The enrollment status response
 */
async function buildEnrollmentStatusResponse(
  ctx: AppContext,
  did: string,
  enrollment: Enrollment,
  authenticatedDid?: string,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    did,
    enrolled: true,
    enrolledAt: enrollment.enrolledAt.toISOString(),
    active: enrollment.active,
    signingKey: enrollment.signingKeyDid,
    enrollmentRkey: enrollment.enrollmentRkey,
  }

  const boundaryValues = await ctx.boundaryResolver.getBoundaries(did)

  if (authenticatedDid) {
    body.boundaries = boundaryValues.map((value: string) => ({ value }))
    if (boundaryValues.length > 0) {
      body.attestation = await tryCreateAttestation(
        ctx,
        did,
        boundaryValues,
        enrollment.signingKeyDid,
      )
    }
  }

  return body
}

/**
 * Try to create attestation for enrollment status
 * @param ctx - The application context
 * @param did - The decentralized identifier (DID) of the enrollment
 * @param boundaries - The boundaries for attestation
 * @param signingKeyDid - The signing key DID
 * @returns The attestation result or undefined if failed
 */
async function tryCreateAttestation(
  ctx: AppContext,
  did: string,
  boundaries: string[],
  signingKeyDid: string,
) {
  try {
    return await ctx.createAttestation(did, boundaries, signingKeyDid)
  } catch (err) {
    ctx.logger?.warn(
      { err: err instanceof Error ? err.message : String(err), actorDid: did },
      'failed to generate attestation for status',
    )
    return undefined
  }
}

/**
 * Register handler for unenrollment
 * @param server - XRPC server
 * @param ctx - Application context
 */
function registerEnrollmentUnenroll(
  server: XrpcServer,
  ctx: AppContext,
  resolveCache: ResolveEnrollmentsCache,
): void {
  const xrpc = server as unknown as XrpcServerInternal
  const { authVerifier } = ctx

  xrpc.method('zone.stratos.enrollment.unenroll', {
    type: 'procedure',
    auth: authVerifier.standard,
    handler: createXrpcHandler(ctx, 'zone.stratos.enrollment.unenroll', {
      handler: async ({ did }) => {
        // 1. Cancel any queued sync and wait for an attempt already in flight.
        // A write still running would otherwise land after step 2 and put the
        // enrollment record back on the user's PDS, where nothing could reach
        // it again once OAuth is revoked.
        await ctx.pdsSyncWorker.cancel(did!)

        // 2. Delete enrollment record from user's PDS (best-effort)
        try {
          const enrollment = await ctx.enrollmentStore.getEnrollment(did!)
          if (enrollment?.enrollmentRkey) {
            await ctx.profileRecordWriter.deleteEnrollmentRecord(
              did!,
              enrollment.enrollmentRkey,
            )
          }
        } catch (err) {
          ctx.logger?.warn(
            { err: err instanceof Error ? err.message : String(err), did },
            'failed to delete PDS enrollment record during unenrollment',
          )
        }

        // 3. Perform hard delete: local enrollment record and actor data
        await ctx.enrollmentService.unenroll(did!)
        resolveCache.invalidate(did!)

        // 4. Delete signing key (if it exists)
        try {
          await ctx.actorStore.deleteSigningKey(did!)
        } catch (err) {
          ctx.logger?.warn(
            { err: err instanceof Error ? err.message : String(err), did },
            'failed to delete signing key during unenrollment',
          )
        }

        // 5. Revoke OAuth sessions
        try {
          await ctx.oauthClient.revoke(did!)
        } catch (err) {
          ctx.logger?.warn(
            { err: err instanceof Error ? err.message : String(err), did },
            'failed to revoke OAuth session during unenrollment',
          )
        }

        return { success: true }
      },
    }),
  })
}

/**
 * Register handlers for enrollment-related operations
 * @param ctx - Application context
 */
function registerResolveEnrollmentsHandler(
  ctx: AppContext,
  cache: ResolveEnrollmentsCache,
): void {
  ctx.app.get(
    '/xrpc/zone.stratos.identity.resolveEnrollments',
    async (req: Request, res: Response) => {
      try {
        const did = req.query.did as string | undefined
        if (!did) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: 'did parameter required',
          })
        }

        const cached = cache.get(did)
        if (cached) {
          return res.json({ did, enrolled: true, boundaries: cached })
        }

        // Snapshot before the awaits: an invalidation that lands while the
        // resolution is in flight bumps the epoch and voids this write.
        const epoch = cache.epoch()
        const enrolled = await ctx.enrollmentService.isEnrolled(did)
        if (!enrolled) {
          return res.json({ did, enrolled: false, boundaries: [] })
        }

        const boundaries = await ctx.boundaryResolver.getBoundaries(did)
        cache.set(did, boundaries, epoch)
        res.json({ did, enrolled: true, boundaries })
      } catch (err) {
        ctx.logger?.error(
          {
            err: err instanceof Error ? err.message : String(err),
            did: req.query.did,
          },
          'identity.resolveEnrollments failed',
        )
        res.status(500).json({
          error: 'InternalError',
          message: 'Failed to resolve enrollments',
        })
      }
    },
  )
}

/**
 * Register handlers for admin boundary-related operations
 * @param ctx - Application context
 */
function registerAdminBoundaryHandlers(
  ctx: AppContext,
  resolveCache: ResolveEnrollmentsCache,
): void {
  registerAddBoundaryHandler(ctx, resolveCache)
  registerRemoveBoundaryHandler(ctx, resolveCache)
  registerSetBoundariesHandler(ctx, resolveCache)
  registerSetActiveHandler(ctx, resolveCache)
  registerAdminUserHandlers(ctx)
}

/**
 * Register handlers for managing who holds admin access.
 * @param ctx - Application context
 */
function registerAdminUserHandlers(ctx: AppContext): void {
  registerListAdminsHandler(ctx)
  registerAddAdminHandler(ctx)
  registerRemoveAdminHandler(ctx)
}

/**
 * Reject anything that is not a syntactically plausible DID, so a typo cannot
 * be granted admin access and then be impossible to match against a session.
 * @param did - Candidate DID
 * @returns Whether the value looks like a DID
 */
function looksLikeDid(did: unknown): did is string {
  return typeof did === 'string' && /^did:[a-z]+:[A-Za-z0-9._:%-]+$/.test(did)
}

/**
 * Register handler for listing admins.
 *
 * Returns config-provided and runtime-granted admins together, tagged by
 * source so the caller can tell which ones are revocable.
 * @param ctx - Application context
 */
function registerListAdminsHandler(ctx: AppContext): void {
  ctx.app.get(
    '/xrpc/zone.stratos.admin.listAdmins',
    async (req: Request, res: Response) => {
      let adminDid: string
      try {
        const auth = await ctx.authVerifier.admin({ req, res })
        adminDid = auth.credentials.did
      } catch {
        return res
          .status(401)
          .json({ error: 'AuthRequired', message: 'Admin auth required' })
      }

      try {
        const granted = await ctx.adminUserStore.list()
        const configured = ctx.cfg.adminDids.map((did) => ({
          did,
          source: 'config' as const,
        }))
        // A DID in both places is shown once, as config: that is the entry
        // that cannot be revoked.
        const admins = [
          ...configured,
          ...granted
            .filter((row) => !ctx.cfg.adminDids.includes(row.did))
            .map((row) => ({
              did: row.did,
              source: 'database' as const,
              addedAt: row.addedAt,
              addedBy: row.addedBy,
            })),
        ]

        res.json({ admins, viewer: adminDid })
      } catch (err) {
        ctx.logger?.error(
          { err: err instanceof Error ? err.message : String(err) },
          'admin.listAdmins failed',
        )
        res.status(500).json({
          error: 'InternalError',
          message: 'Failed to list admins',
        })
      }
    },
  )
}

/**
 * Register handler for granting admin access.
 * @param ctx - Application context
 */
function registerAddAdminHandler(ctx: AppContext): void {
  ctx.app.post(
    '/xrpc/zone.stratos.admin.addAdmin',
    adminJsonParser,
    async (req: Request, res: Response) => {
      let adminDid: string
      try {
        const auth = await ctx.authVerifier.admin({ req, res })
        adminDid = auth.credentials.did
      } catch {
        return res
          .status(401)
          .json({ error: 'AuthRequired', message: 'Admin auth required' })
      }

      try {
        const { did } = req.body as { did?: unknown }
        if (!looksLikeDid(did)) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: 'a valid did is required',
          })
        }

        if (ctx.cfg.adminDids.includes(did)) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: `${did} is already an admin through configuration`,
          })
        }

        await ctx.adminUserStore.add(did, adminDid)
        ctx.logger?.info({ adminDid, targetDid: did }, 'admin granted access')
        res.json({ did })
      } catch (err) {
        ctx.logger?.error(
          { err: err instanceof Error ? err.message : String(err) },
          'admin.addAdmin failed',
        )
        res
          .status(500)
          .json({ error: 'InternalError', message: 'Failed to add admin' })
      }
    },
  )
}

/**
 * Register handler for revoking admin access.
 *
 * Config-provided admins cannot be revoked here: they are the recovery path if
 * the database is emptied. Self-revocation is refused so an operator cannot
 * lock themselves out in one click.
 * @param ctx - Application context
 */
function registerRemoveAdminHandler(ctx: AppContext): void {
  ctx.app.post(
    '/xrpc/zone.stratos.admin.removeAdmin',
    adminJsonParser,
    async (req: Request, res: Response) => {
      let adminDid: string
      try {
        const auth = await ctx.authVerifier.admin({ req, res })
        adminDid = auth.credentials.did
      } catch {
        return res
          .status(401)
          .json({ error: 'AuthRequired', message: 'Admin auth required' })
      }

      try {
        const { did } = req.body as { did?: unknown }
        if (!looksLikeDid(did)) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: 'a valid did is required',
          })
        }

        if (ctx.cfg.adminDids.includes(did)) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: `${did} is an admin through configuration and must be removed there`,
          })
        }

        if (did === adminDid) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: 'you cannot revoke your own admin access',
          })
        }

        if (!(await ctx.adminUserStore.has(did))) {
          return res
            .status(404)
            .json({ error: 'NotFound', message: `${did} is not an admin` })
        }

        await ctx.adminUserStore.remove(did)
        ctx.logger?.info({ adminDid, targetDid: did }, 'admin revoked access')
        res.json({ did })
      } catch (err) {
        ctx.logger?.error(
          { err: err instanceof Error ? err.message : String(err) },
          'admin.removeAdmin failed',
        )
        res
          .status(500)
          .json({ error: 'InternalError', message: 'Failed to remove admin' })
      }
    },
  )
}

/**
 * Register handler for activating and deactivating a member.
 *
 * Deactivation is reversible and leaves the enrollment and its boundaries in
 * place, unlike unenrollment, which the member drives themselves and which
 * also removes their PDS enrollment record.
 * @param ctx - Application context
 */
function registerSetActiveHandler(
  ctx: AppContext,
  resolveCache: ResolveEnrollmentsCache,
): void {
  ctx.app.post(
    '/xrpc/zone.stratos.admin.setActive',
    adminJsonParser,
    async (req: Request, res: Response) => {
      let adminDid: string
      try {
        const auth = await ctx.authVerifier.admin({ req, res })
        adminDid = auth.credentials.did
      } catch {
        return res
          .status(401)
          .json({ error: 'AuthRequired', message: 'Admin auth required' })
      }

      try {
        const { did, active } = req.body as { did?: unknown; active?: unknown }

        if (!looksLikeDid(did) || typeof active !== 'boolean') {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: 'did and a boolean active are required',
          })
        }

        const enrollment = await ctx.enrollmentStore.getEnrollment(did)
        if (!enrollment) {
          return res.status(404).json({
            error: 'NotFound',
            message: `user ${did} is not enrolled`,
          })
        }

        if (enrollment.active !== active) {
          await ctx.enrollmentStore.updateEnrollment(did, { active })
          resolveCache.invalidate(did)
        }

        ctx.logger?.info(
          { adminDid, targetDid: did, active },
          active ? 'admin activated member' : 'admin deactivated member',
        )
        res.json({ did, active })
      } catch (err) {
        ctx.logger?.error(
          { err: err instanceof Error ? err.message : String(err) },
          'admin.setActive failed',
        )
        res.status(500).json({
          error: 'InternalError',
          message: 'Failed to update member state',
        })
      }
    },
  )
}

/**
 * JSON body parser for the admin boundary routes. The global parser in
 * index.ts skips every `/xrpc/` path (xrpc-server parses those), but these
 * admin routes are raw express handlers registered under `/xrpc/`, so they
 * must parse their own JSON body or `req.body` is undefined.
 */
const adminJsonParser = express.json({ limit: '100kb' })

/**
 * Register handler for adding a boundary
 * @param ctx - Application context
 */
function registerAddBoundaryHandler(
  ctx: AppContext,
  resolveCache: ResolveEnrollmentsCache,
): void {
  ctx.app.post(
    '/xrpc/zone.stratos.admin.addBoundary',
    adminJsonParser,
    async (req: Request, res: Response) => {
      let adminDid: string
      try {
        const auth = await ctx.authVerifier.admin({ req, res })
        adminDid = auth.credentials.did
      } catch {
        return res
          .status(401)
          .json({ error: 'AuthRequired', message: 'Admin auth required' })
      }

      try {
        const { did, boundary } = req.body as {
          did?: string
          boundary?: string
        }

        if (!did || !boundary) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: 'did and boundary are required',
          })
        }

        const allowedDomains = ctx.cfg.stratos.allowedDomains
        if (!allowedDomains.includes(boundary)) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: `boundary "${boundary}" is not in allowed domains`,
          })
        }

        const enrolled = await ctx.enrollmentStore.isEnrolled(did)
        if (!enrolled) {
          return res.status(404).json({
            error: 'NotFound',
            message: `user ${did} is not enrolled`,
          })
        }

        const generation = await enqueuePdsSync(ctx, did)

        const priorBoundaries = await ctx.enrollmentStore.getBoundaries(did)
        await ctx.enrollmentStore.addBoundary(did, boundary)
        resolveCache.invalidate(did)
        const boundaries = await ctx.enrollmentStore.getBoundaries(did)

        emitBoundaryChangeEvent(ctx, did, boundaries, priorBoundaries)

        const pdsSync = await runPdsSync(ctx, did, generation)

        ctx.logger?.info(
          { adminDid, targetDid: did, boundary, pdsSync },
          'admin added boundary',
        )
        res.json({ did, boundaries, pdsSync })
      } catch (err) {
        ctx.logger?.error(
          { err: err instanceof Error ? err.message : String(err) },
          'admin.addBoundary failed',
        )
        res.status(500).json({
          error: 'InternalError',
          message: 'Failed to add boundary',
        })
      }
    },
  )
}

/**
 * Register remove boundary handler for admin
 * @param ctx - The application context
 */
function registerRemoveBoundaryHandler(
  ctx: AppContext,
  resolveCache: ResolveEnrollmentsCache,
): void {
  // POST /xrpc/zone.stratos.admin.removeBoundary
  ctx.app.post(
    '/xrpc/zone.stratos.admin.removeBoundary',
    adminJsonParser,
    async (req: Request, res: Response) => {
      let adminDid: string
      try {
        const auth = await ctx.authVerifier.admin({ req, res })
        adminDid = auth.credentials.did
      } catch {
        return res
          .status(401)
          .json({ error: 'AuthRequired', message: 'Admin auth required' })
      }

      try {
        const { did, boundary } = req.body as {
          did?: string
          boundary?: string
        }

        if (!did || !boundary) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: 'did and boundary are required',
          })
        }

        const enrolled = await ctx.enrollmentStore.isEnrolled(did)
        if (!enrolled) {
          return res.status(404).json({
            error: 'NotFound',
            message: `user ${did} is not enrolled`,
          })
        }

        const generation = await enqueuePdsSync(ctx, did)

        const priorBoundaries = await ctx.enrollmentStore.getBoundaries(did)
        await ctx.enrollmentStore.removeBoundary(did, boundary)
        resolveCache.invalidate(did)
        const boundaries = await ctx.enrollmentStore.getBoundaries(did)

        emitBoundaryChangeEvent(ctx, did, boundaries, priorBoundaries)

        const pdsSync = await runPdsSync(ctx, did, generation)

        ctx.logger?.info(
          { adminDid, targetDid: did, boundary, pdsSync },
          'admin removed boundary',
        )
        res.json({ did, boundaries, pdsSync })
      } catch (err) {
        ctx.logger?.error(
          { err: err instanceof Error ? err.message : String(err) },
          'admin.removeBoundary failed',
        )
        res.status(500).json({
          error: 'InternalError',
          message: 'Failed to remove boundary',
        })
      }
    },
  )
}

/**
 * Register handler for setting boundaries
 * @param ctx - Application context
 */
function registerSetBoundariesHandler(
  ctx: AppContext,
  resolveCache: ResolveEnrollmentsCache,
): void {
  ctx.app.post(
    '/xrpc/zone.stratos.admin.setBoundaries',
    adminJsonParser,
    async (req: Request, res: Response) => {
      let adminDid: string
      try {
        const auth = await ctx.authVerifier.admin({ req, res })
        adminDid = auth.credentials.did
      } catch {
        return res
          .status(401)
          .json({ error: 'AuthRequired', message: 'Admin auth required' })
      }

      try {
        const { did, boundaries } = req.body as {
          did?: string
          boundaries?: string[]
        }

        if (!did || !Array.isArray(boundaries)) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: 'did and boundaries array are required',
          })
        }

        const allowedDomains = ctx.cfg.stratos.allowedDomains
        const invalid = boundaries.filter((b) => !allowedDomains.includes(b))
        if (invalid.length > 0) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: `boundaries not in allowed domains: ${invalid.join(', ')}`,
          })
        }

        const enrolled = await ctx.enrollmentStore.isEnrolled(did)
        if (!enrolled) {
          return res.status(404).json({
            error: 'NotFound',
            message: `user ${did} is not enrolled`,
          })
        }

        const generation = await enqueuePdsSync(ctx, did)

        const priorBoundaries = await ctx.enrollmentStore.getBoundaries(did)
        await ctx.enrollmentStore.setBoundaries(did, boundaries)
        resolveCache.invalidate(did)

        // Re-read the EFFECTIVE persisted set: the store decorator force-includes
        // the reserved all-members domain, so the requested `boundaries` may omit
        // it. Emitting/returning the requested set would make a feedgen diff the
        // reserved domain as "lost" and wrongly purge the actor's reserved-domain
        // derived state.
        const effectiveBoundaries = await ctx.enrollmentStore.getBoundaries(did)

        emitBoundaryChangeEvent(ctx, did, effectiveBoundaries, priorBoundaries)

        const pdsSync = await runPdsSync(ctx, did, generation)

        ctx.logger?.info(
          {
            adminDid,
            targetDid: did,
            boundaryCount: effectiveBoundaries.length,
            pdsSync,
          },
          'admin set boundaries',
        )
        res.json({ did, boundaries: effectiveBoundaries, pdsSync })
      } catch (err) {
        ctx.logger?.error(
          { err: err instanceof Error ? err.message : String(err) },
          'admin.setBoundaries failed',
        )
        res.status(500).json({
          error: 'InternalError',
          message: 'Failed to set boundaries',
        })
      }
    },
  )
}

/**
 * A member row as returned by the admin listing, with boundaries attached.
 */
interface ListedEnrollment {
  did: string
  enrolledAt: string
  active: boolean
  isService: boolean
  custody: 'stratos' | 'pds'
  repoHost?: string
  boundaries: string[]
}

/**
 * Attach boundaries to enrollment rows.
 *
 * Read through the store rather than the join table directly so the
 * reserved-domain decorator still force-includes the all-members domain.
 * @param ctx - Application context
 * @param rows - Enrollment rows to hydrate
 * @returns The rows with their boundaries attached
 */
async function withBoundaries(
  ctx: AppContext,
  rows: Array<{
    did: string
    enrolledAt: string
    active: boolean
    isService?: boolean
    custody?: 'stratos' | 'pds'
    repoHost?: string
  }>,
): Promise<ListedEnrollment[]> {
  const boundaries = await Promise.all(
    rows.map((row) => ctx.enrollmentStore.getBoundaries(row.did)),
  )
  return rows.map((row, index) => ({
    did: row.did,
    enrolledAt: row.enrolledAt,
    active: row.active,
    isService: row.isService ?? false,
    custody: row.custody ?? 'stratos',
    ...(row.repoHost ? { repoHost: row.repoHost } : {}),
    boundaries: boundaries[index],
  }))
}

/**
 * Read one unfiltered page of enrollments.
 *
 * Over-fetches by one to learn whether another page exists, so a final page
 * that happens to be exactly `limit` long does not hand back a cursor that
 * resolves to nothing.
 * @param ctx - Application context
 * @param limit - Page size
 * @param cursor - DID to resume after
 * @returns The page and whether more results follow
 */
async function collectPage(
  ctx: AppContext,
  limit: number,
  cursor?: string,
): Promise<{
  enrollments: ListedEnrollment[]
  hasMore: boolean
  nextCursor?: string
}> {
  const rows = await ctx.enrollmentStore.listEnrollments({
    limit: limit + 1,
    cursor,
  })
  const hasMore = rows.length > limit
  return {
    enrollments: await withBoundaries(
      ctx,
      hasMore ? rows.slice(0, limit) : rows,
    ),
    hasMore,
  }
}

/**
 * Read one page of enrollments matching a predicate.
 *
 * There is no index to filter on, so this scans the DID-ordered listing in
 * chunks, stopping as soon as the page is full. The cursor is the last
 * *matching* DID, so resuming re-scans only the non-matching rows that
 * followed it. Filtering here rather than in the client keeps pagination
 * meaningful: a page is always `limit` matches, not `limit` rows of which
 * some are hidden.
 * @param ctx - Application context
 * @param limit - Page size
 * @param matches - Predicate every returned member must satisfy
 * @param cursor - DID to resume after
 * @returns The page and whether more results follow
 */
async function collectFilteredPage(
  ctx: AppContext,
  limit: number,
  matches: (enrollment: ListedEnrollment) => boolean,
  cursor?: string,
): Promise<{
  enrollments: ListedEnrollment[]
  hasMore: boolean
  nextCursor?: string
}> {
  const SCAN_CHUNK = 100
  // A filter matching nothing would otherwise scan the whole table, issuing a
  // boundary read per row, and starve the connection pool for every other
  // request. Stop after this many rows and hand back a cursor so the caller
  // can resume; pagination still reaches every match, one bounded step at a
  // time.
  const MAX_ROWS_SCANNED = 1_000
  const found: ListedEnrollment[] = []
  let scanCursor = cursor
  let scanned = 0
  let exhausted = false

  while (found.length <= limit && scanned < MAX_ROWS_SCANNED) {
    const rows = await ctx.enrollmentStore.listEnrollments({
      limit: SCAN_CHUNK,
      cursor: scanCursor,
    })
    if (rows.length === 0) {
      exhausted = true
      break
    }
    scanCursor = rows[rows.length - 1].did
    scanned += rows.length

    for (const enrollment of await withBoundaries(ctx, rows)) {
      if (!matches(enrollment)) continue
      found.push(enrollment)
      if (found.length > limit) break
    }

    if (rows.length < SCAN_CHUNK) {
      exhausted = true
      break
    }
  }

  // More results may follow either because the page filled, or because the
  // scan budget ran out before reaching the end of the table.
  const pageFull = found.length > limit
  const hasMore = pageFull || !exhausted
  const enrollments = pageFull ? found.slice(0, limit) : found

  // Resume after the last row this page accounts for. When the page filled,
  // that is its last match — rows beyond it were never examined. When the
  // budget ran out first, every scanned row was examined, so resume from the
  // scan position rather than re-walking the non-matching tail.
  const nextCursor = pageFull
    ? enrollments[enrollments.length - 1].did
    : scanCursor

  return {
    enrollments,
    hasMore,
    nextCursor: hasMore ? nextCursor : undefined,
  }
}

/**
 * Register handler for listing enrollments.
 *
 * Paginates over the enrollment store using the DID-ordered cursor convention
 * already used by the sync subscription. Boundaries are read through the store
 * (not raw SQL) so the reserved-domain decorator still force-includes the
 * all-members domain; the per-row reads are issued in parallel to keep a full
 * page to a single round-trip's worth of latency.
 *
 * @param ctx - Application context
 */
function registerListEnrollmentsHandler(ctx: AppContext): void {
  const DEFAULT_LIMIT = 50
  const MAX_LIMIT = 100

  ctx.app.get(
    '/xrpc/zone.stratos.admin.listEnrollments',
    async (req: Request, res: Response) => {
      try {
        await ctx.authVerifier.admin({ req, res })
      } catch {
        return res
          .status(401)
          .json({ error: 'AuthRequired', message: 'Admin auth required' })
      }

      try {
        const rawLimit = req.query.limit
        let limit = DEFAULT_LIMIT
        if (rawLimit !== undefined) {
          // Express parses `?limit[]=1` into an array, and Number(['1']) is 1,
          // so non-string input must be rejected before coercion.
          if (typeof rawLimit !== 'string') {
            return res.status(400).json({
              error: 'InvalidRequest',
              message: `limit must be an integer between 1 and ${MAX_LIMIT}`,
            })
          }
          limit = Number(rawLimit)
          if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
            return res.status(400).json({
              error: 'InvalidRequest',
              message: `limit must be an integer between 1 and ${MAX_LIMIT}`,
            })
          }
        }

        const rawCursor = req.query.cursor
        if (rawCursor !== undefined && typeof rawCursor !== 'string') {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: 'cursor must be a string',
          })
        }

        const rawBoundary = req.query.boundary
        if (
          rawBoundary !== undefined &&
          (typeof rawBoundary !== 'string' || rawBoundary.length === 0)
        ) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: 'boundary must be a non-empty string',
          })
        }

        const rawActive = req.query.active
        if (
          rawActive !== undefined &&
          rawActive !== 'true' &&
          rawActive !== 'false'
        ) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: "active must be 'true' or 'false'",
          })
        }
        const wantActive =
          rawActive === undefined ? undefined : rawActive === 'true'

        const rawCustody = req.query.custody
        if (
          rawCustody !== undefined &&
          rawCustody !== 'stratos' &&
          rawCustody !== 'pds'
        ) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: "custody must be 'stratos' or 'pds'",
          })
        }

        const filtered =
          rawBoundary !== undefined ||
          wantActive !== undefined ||
          rawCustody !== undefined
        const { enrollments, hasMore, nextCursor } = filtered
          ? await collectFilteredPage(
              ctx,
              limit,
              (enrollment) =>
                (rawBoundary === undefined ||
                  enrollment.boundaries.includes(rawBoundary)) &&
                (wantActive === undefined ||
                  enrollment.active === wantActive) &&
                (rawCustody === undefined || enrollment.custody === rawCustody),
              rawCursor,
            )
          : await collectPage(ctx, limit, rawCursor)

        res.json({
          enrollments,
          // A filtered scan supplies its own cursor, which may point past the
          // last returned row when the scan budget was spent — including when
          // the page came back empty.
          cursor: hasMore
            ? (nextCursor ?? enrollments[enrollments.length - 1]?.did)
            : undefined,
          // A filtered total would need a full scan; the unfiltered count
          // would misreport the result set, so it is omitted instead.
          total: filtered
            ? undefined
            : await ctx.enrollmentStore.enrollmentCount(),
        })
      } catch (err) {
        ctx.logger?.error(
          { err: err instanceof Error ? err.message : String(err) },
          'admin.listEnrollments failed',
        )
        res.status(500).json({
          error: 'InternalError',
          message: 'Failed to list enrollments',
        })
      }
    },
  )
}

function registerGetRepoHostHandler(ctx: AppContext): void {
  ctx.app.get(
    '/xrpc/zone.stratos.admin.getRepoHost',
    async (req: Request, res: Response) => {
      try {
        await ctx.authVerifier.admin({ req, res })
      } catch {
        return res
          .status(401)
          .json({ error: 'AuthRequired', message: 'Admin auth required' })
      }

      const did = req.query.did
      if (typeof did !== 'string' || did.length === 0) {
        return res.status(400).json({
          error: 'InvalidRequest',
          message: 'did must be a non-empty string',
        })
      }
      try {
        ensureValidDid(did)
      } catch {
        return res.status(400).json({
          error: 'InvalidRequest',
          message: 'did must be a valid DID',
        })
      }

      try {
        const enrollment = await ctx.enrollmentStore.getEnrollment(did)
        if (!enrollment) {
          return res.status(404).json({
            error: 'NotFound',
            message: 'Enrollment not found',
          })
        }
        const custody = enrollment.custody ?? 'stratos'
        if (enrollment.isService || custody === 'stratos') {
          return res.json({
            did,
            custody,
            isService: enrollment.isService ?? false,
            resolutions: [],
          })
        }

        const boundaries = await ctx.enrollmentStore.getBoundaries(did)
        const hostDeps = createRepoHostResolverDeps(
          ctx.idResolver,
          enrollment.repoHost,
        )
        const resolutions = await Promise.all(
          boundaries.flatMap((boundary) => {
            const result = boundaryToSpaceUri(boundary, SPACE_TYPE)
            if (!result.ok) return []
            return [
              resolveRepoHost(result.value, did, hostDeps).then((resolved) => ({
                boundary,
                spaceUri: result.value,
                ...(resolved
                  ? { host: resolved.host, source: resolved.source }
                  : {}),
              })),
            ]
          }),
        )
        return res.json({
          did,
          custody,
          isService: false,
          resolutions,
        })
      } catch (err) {
        ctx.logger?.error(
          { err: err instanceof Error ? err.message : String(err), did },
          'admin.getRepoHost failed',
        )
        return res.status(500).json({
          error: 'InternalError',
          message: 'Failed to resolve repository hosts',
        })
      }
    },
  )
}

/**
 * Register handler for listing domains
 * @param ctx - Application context
 */
function registerListDomainsHandler(ctx: AppContext): void {
  ctx.app.get(
    '/xrpc/zone.stratos.server.listDomains',
    (_req: Request, res: Response) => {
      try {
        res.json({ domains: ctx.cfg.stratos.allowedDomains })
      } catch (err) {
        ctx.logger?.error(
          { err: err instanceof Error ? err.message : String(err) },
          'server.listDomains failed',
        )
        res.status(500).json({
          error: 'InternalError',
          message: 'Failed to list domains',
        })
      }
    },
  )
}

const PDS_SYNC_STATUS_DEFAULT_LIMIT = 50
const PDS_SYNC_STATUS_MAX_LIMIT = 100

/** Encode a page key as an opaque cursor. The separator is in neither part. */
function encodePdsSyncCursor(key: PdsSyncPageKey): string {
  return Buffer.from(`${key.firstQueuedAt}|${key.did}`).toString('base64url')
}

function decodePdsSyncCursor(cursor: string): PdsSyncPageKey | undefined {
  const decoded = Buffer.from(cursor, 'base64url').toString()
  const separator = decoded.indexOf('|')
  if (separator < 1 || separator === decoded.length - 1) return undefined
  return {
    firstQueuedAt: decoded.slice(0, separator),
    did: decoded.slice(separator + 1),
  }
}

/**
 * Register handler for listing PDS enrollment-record sync jobs.
 *
 * Surfaces the durable sync queue so an operator can see which actors' PDS
 * records are still behind (`pending`) or need intervention (`failed`).
 * Paginated so a fleet-wide failure cannot make one read load the whole
 * backlog.
 */
function registerListPdsSyncStatusHandler(ctx: AppContext): void {
  ctx.app.get(
    '/xrpc/zone.stratos.admin.listPdsSyncStatus',
    async (req: Request, res: Response) => {
      try {
        await ctx.authVerifier.admin({ req, res })
      } catch {
        return res
          .status(401)
          .json({ error: 'AuthRequired', message: 'Admin auth required' })
      }

      const rawLimit = Number(req.query.limit ?? PDS_SYNC_STATUS_DEFAULT_LIMIT)
      if (
        !Number.isInteger(rawLimit) ||
        rawLimit < 1 ||
        rawLimit > PDS_SYNC_STATUS_MAX_LIMIT
      ) {
        return res.status(400).json({
          error: 'InvalidRequest',
          message: `limit must be an integer between 1 and ${PDS_SYNC_STATUS_MAX_LIMIT}`,
        })
      }

      let after: PdsSyncPageKey | undefined
      if (typeof req.query.cursor === 'string') {
        after = decodePdsSyncCursor(req.query.cursor)
        if (!after) {
          return res
            .status(400)
            .json({ error: 'InvalidRequest', message: 'malformed cursor' })
        }
      }

      try {
        // Fetch one extra row so an exactly-full final page emits no cursor.
        const rows = await ctx.pdsSyncQueue.list(rawLimit + 1, after)
        const hasMore = rows.length > rawLimit
        const jobs = hasMore ? rows.slice(0, rawLimit) : rows
        const last = jobs.at(-1)
        const cursor = hasMore && last ? encodePdsSyncCursor(last) : undefined
        res.json(cursor ? { jobs, cursor } : { jobs })
      } catch (err) {
        ctx.logger?.error(
          { err: err instanceof Error ? err.message : String(err) },
          'admin.listPdsSyncStatus failed',
        )
        res.status(500).json({
          error: 'InternalError',
          message: 'Failed to list PDS sync status',
        })
      }
    },
  )
}

/**
 * Register handler for reviving terminally failed PDS sync jobs.
 *
 * A fault that every attempt sees alike — a JWKS rotation, clock skew — marks
 * every job `'failed'` at once. Without this an operator would have to redo
 * one admin mutation per affected actor to recover.
 * @param ctx - Application context
 */
function registerRequeuePdsSyncHandler(ctx: AppContext): void {
  ctx.app.post(
    '/xrpc/zone.stratos.admin.requeuePdsSync',
    async (req: Request, res: Response) => {
      let adminDid: string
      try {
        const auth = await ctx.authVerifier.admin({ req, res })
        adminDid = auth.credentials.did
      } catch {
        return res
          .status(401)
          .json({ error: 'AuthRequired', message: 'Admin auth required' })
      }

      try {
        const requeued = await ctx.pdsSyncQueue.requeueFailed()
        ctx.logger?.info({ adminDid, requeued }, 'admin requeued PDS sync jobs')
        res.json({ requeued })
      } catch (err) {
        ctx.logger?.error(
          { err: err instanceof Error ? err.message : String(err) },
          'admin.requeuePdsSync failed',
        )
        res.status(500).json({
          error: 'InternalError',
          message: 'Failed to requeue PDS sync jobs',
        })
      }
    },
  )
}

/**
 * Emit a service-stream `boundaries` change event.
 *
 * Fired whenever an enrolled actor's boundary set is mutated in place (admin
 * add/remove/set) so downstream services can drop derived state for any
 * boundary the actor left, WITHOUT waiting for a cache TTL. Consumed by
 * `eventInScope` boundary diffing in subscription/subscribe-records.ts.
 * Emission is skipped when the set is unchanged (idempotent no-op).
 * `priorBoundaries` is carried for stream scoping only and is not written to the
 * wire frame.
 *
 * @param ctx - Application context
 * @param did - DID whose boundaries changed
 * @param boundaries - The boundary set AFTER the change (`boundaries-after`)
 * @param priorBoundaries - The boundary set BEFORE the change
 */
function emitBoundaryChangeEvent(
  ctx: AppContext,
  did: string,
  boundaries: string[],
  priorBoundaries: string[],
): void {
  if (boundarySetsEqual(priorBoundaries, boundaries)) return
  ctx.enrollmentEvents.emit('enrollment', {
    did,
    action: 'boundaries',
    boundaries,
    priorBoundaries,
    time: new Date().toISOString(),
  })
  ctx.logger?.info(
    { did, boundaryCount: boundaries.length },
    'emitted boundary-change event',
  )
}

/**
 * Whether two boundary sets are equal regardless of order.
 * @param a - First boundary set
 * @param b - Second boundary set
 * @returns True if both sets contain exactly the same boundaries
 */
function boundarySetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((x) => set.has(x))
}

/**
 * Record durable sync intent BEFORE the local boundary commit. A crash in
 * between then leaves a queued job rather than silence, and replaying it is
 * harmless because the job re-derives boundaries when it runs.
 *
 * This runs before anything commits, so letting a queue-write failure reject
 * the request is honest: the caller gets an error and nothing changed.
 *
 * @param ctx - Application context
 * @param did - DID of the enrollment
 * @returns The generation to pass to {@link runPdsSync}
 */
async function enqueuePdsSync(ctx: AppContext, did: string): Promise<number> {
  return ctx.pdsSyncWorker.enqueue(did)
}

/**
 * Run the inline sync attempt for a mutation that has already committed.
 *
 * @param ctx - Application context
 * @param did - DID of the enrollment
 * @param generation - Generation returned by {@link enqueuePdsSync}
 * @returns 'ok' when the PDS record is current, 'deferred' when the worker
 * will retry in the background
 */
async function runPdsSync(
  ctx: AppContext,
  did: string,
  generation: number,
): Promise<'ok' | 'deferred'> {
  try {
    return await ctx.pdsSyncWorker.kick(did, generation)
  } catch (err) {
    // The boundary change already committed and the event already fired. A
    // queue-write failure must not turn that into a 500; the job is durable
    // and the ticker still owns it.
    ctx.logger?.warn(
      { err: err instanceof Error ? err.message : String(err), did },
      'pds sync attempt failed inline; job remains queued',
    )
    return 'deferred'
  }
}
