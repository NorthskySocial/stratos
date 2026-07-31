import express, { type Request, type Response } from 'express'
import { Agent } from '@atproto/api'
import { InvalidRequestError, Server as XrpcServer } from '@atproto/xrpc-server'
import { type Enrollment } from '@northskysocial/stratos-core'
import type { AppContext } from '../../context-types.js'
import { type XrpcServerInternal } from '../../api/types.js'
import { createXrpcHandler } from '../../api/util.js'
import { serviceDIDToRkey } from '../../oauth'
import { verifyEnrolled } from './internal/auth.js'

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
  registerEnrollmentStatus(server, ctx)
  registerEnrollmentUnenroll(server, ctx)
  registerResolveEnrollmentsHandler(ctx)
  registerAdminBoundaryHandlers(ctx)
  registerListEnrollmentsHandler(ctx)
  registerListDomainsHandler(ctx)
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
            // If verifyEnrolled doesn't throw, they are eligible
            return { did, enrolled: true, active: false }
          } catch {
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
function registerEnrollmentUnenroll(server: XrpcServer, ctx: AppContext): void {
  const xrpc = server as unknown as XrpcServerInternal
  const { authVerifier } = ctx

  xrpc.method('zone.stratos.enrollment.unenroll', {
    type: 'procedure',
    auth: authVerifier.standard,
    handler: createXrpcHandler(ctx, 'zone.stratos.enrollment.unenroll', {
      handler: async ({ did }) => {
        // 1. Delete enrollment record from user's PDS (best-effort)
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

        // 2. Perform hard delete: local enrollment record and actor data
        await ctx.enrollmentService.unenroll(did!)

        // 3. Delete signing key (if it exists)
        try {
          await ctx.actorStore.deleteSigningKey(did!)
        } catch (err) {
          ctx.logger?.warn(
            { err: err instanceof Error ? err.message : String(err), did },
            'failed to delete signing key during unenrollment',
          )
        }

        // 4. Revoke OAuth sessions
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
function registerResolveEnrollmentsHandler(ctx: AppContext): void {
  const cache = new Map<string, { boundaries: string[]; timestamp: number }>()
  const CACHE_TTL = 60 * 1000 // 1 minute

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
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
          return res.json({
            did,
            enrolled: true,
            boundaries: cached.boundaries,
          })
        }

        const enrolled = await ctx.enrollmentService.isEnrolled(did)
        if (!enrolled) {
          return res.json({ did, enrolled: false, boundaries: [] })
        }

        const boundaries = await ctx.boundaryResolver.getBoundaries(did)
        cache.set(did, { boundaries, timestamp: Date.now() })
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
function registerAdminBoundaryHandlers(ctx: AppContext): void {
  registerAddBoundaryHandler(ctx)
  registerRemoveBoundaryHandler(ctx)
  registerSetBoundariesHandler(ctx)
  registerSetActiveHandler(ctx)
}

/**
 * Register handler for activating and deactivating a member.
 *
 * Deactivation is reversible and leaves the enrollment and its boundaries in
 * place, unlike unenrollment, which the member drives themselves and which
 * also removes their PDS enrollment record.
 * @param ctx - Application context
 */
function registerSetActiveHandler(ctx: AppContext): void {
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
        const { did, active } = req.body as { did?: string; active?: boolean }

        if (!did || typeof active !== 'boolean') {
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
function registerAddBoundaryHandler(ctx: AppContext): void {
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

        const priorBoundaries = await ctx.enrollmentStore.getBoundaries(did)
        await ctx.enrollmentStore.addBoundary(did, boundary)
        const boundaries = await ctx.enrollmentStore.getBoundaries(did)

        emitBoundaryChangeEvent(ctx, did, boundaries, priorBoundaries)

        let pdsSync: 'ok' | 'failed' = 'ok'
        try {
          await updatePdsEnrollmentRecord(ctx, did, boundaries)
        } catch (err) {
          pdsSync = 'failed'
          ctx.logger?.warn(
            { err: err instanceof Error ? err.message : String(err), did },
            'failed to update PDS enrollment record after addBoundary',
          )
        }

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
function registerRemoveBoundaryHandler(ctx: AppContext): void {
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

        const priorBoundaries = await ctx.enrollmentStore.getBoundaries(did)
        await ctx.enrollmentStore.removeBoundary(did, boundary)
        const boundaries = await ctx.enrollmentStore.getBoundaries(did)

        emitBoundaryChangeEvent(ctx, did, boundaries, priorBoundaries)

        let pdsSync: 'ok' | 'failed' = 'ok'
        try {
          await updatePdsEnrollmentRecord(ctx, did, boundaries)
        } catch (err) {
          pdsSync = 'failed'
          ctx.logger?.warn(
            { err: err instanceof Error ? err.message : String(err), did },
            'failed to update PDS enrollment record after removeBoundary',
          )
        }

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
function registerSetBoundariesHandler(ctx: AppContext): void {
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

        const priorBoundaries = await ctx.enrollmentStore.getBoundaries(did)
        await ctx.enrollmentStore.setBoundaries(did, boundaries)

        // Re-read the EFFECTIVE persisted set: the store decorator force-includes
        // the reserved all-members domain, so the requested `boundaries` may omit
        // it. Emitting/returning the requested set would make a feedgen diff the
        // reserved domain as "lost" and wrongly purge the actor's reserved-domain
        // derived state.
        const effectiveBoundaries = await ctx.enrollmentStore.getBoundaries(did)

        emitBoundaryChangeEvent(ctx, did, effectiveBoundaries, priorBoundaries)

        let pdsSync: 'ok' | 'failed' = 'ok'
        try {
          await updatePdsEnrollmentRecord(ctx, did, effectiveBoundaries)
        } catch (err) {
          pdsSync = 'failed'
          ctx.logger?.warn(
            { err: err instanceof Error ? err.message : String(err), did },
            'failed to update PDS enrollment record after setBoundaries',
          )
        }

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
): Promise<{ enrollments: ListedEnrollment[]; hasMore: boolean }> {
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
 * Read one page of enrollments holding a given boundary.
 *
 * There is no reverse boundary index, so this scans the DID-ordered listing in
 * chunks and filters, stopping as soon as the page is full. The cursor is the
 * last *matching* DID, so resuming re-scans only the non-matching rows that
 * followed it.
 * @param ctx - Application context
 * @param limit - Page size
 * @param boundary - Boundary every returned member must hold
 * @param cursor - DID to resume after
 * @returns The page and whether more results follow
 */
async function collectFilteredPage(
  ctx: AppContext,
  limit: number,
  boundary: string,
  cursor?: string,
): Promise<{ enrollments: ListedEnrollment[]; hasMore: boolean }> {
  const SCAN_CHUNK = 100
  const matches: ListedEnrollment[] = []
  let scanCursor = cursor

  while (matches.length <= limit) {
    const rows = await ctx.enrollmentStore.listEnrollments({
      limit: SCAN_CHUNK,
      cursor: scanCursor,
    })
    if (rows.length === 0) break
    scanCursor = rows[rows.length - 1].did

    for (const enrollment of await withBoundaries(ctx, rows)) {
      if (!enrollment.boundaries.includes(boundary)) continue
      matches.push(enrollment)
      if (matches.length > limit) break
    }

    if (rows.length < SCAN_CHUNK) break
  }

  const hasMore = matches.length > limit
  return {
    enrollments: hasMore ? matches.slice(0, limit) : matches,
    hasMore,
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

        const { enrollments, hasMore } = rawBoundary
          ? await collectFilteredPage(ctx, limit, rawBoundary, rawCursor)
          : await collectPage(ctx, limit, rawCursor)

        res.json({
          enrollments,
          cursor: hasMore ? enrollments[enrollments.length - 1].did : undefined,
          // A filtered total would need a full scan; the unfiltered count
          // would misreport the result set, so it is omitted instead.
          total: rawBoundary
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
 * Update the PDS enrollment record with new boundaries
 * @param ctx - Application context
 * @param did - DID of the enrollment
 * @param boundaries - New boundaries to set
 */
async function updatePdsEnrollmentRecord(
  ctx: AppContext,
  did: string,
  boundaries: string[],
): Promise<void> {
  const enrollment = await ctx.enrollmentStore.getEnrollment(did)
  if (!enrollment?.signingKeyDid) return

  const attestation = await ctx.createAttestation(
    did,
    boundaries,
    enrollment.signingKeyDid,
  )

  const rkey = serviceDIDToRkey(ctx.serviceDid)
  const oauthSession = await ctx.oauthClient.restore(did)
  const agent = new Agent(oauthSession)

  await agent.com.atproto.repo.putRecord({
    repo: did,
    collection: 'zone.stratos.actor.enrollment',
    rkey,
    record: {
      service: ctx.cfg.service.publicUrl,
      boundaries: boundaries.map((value) => ({ value })),
      signingKey: enrollment.signingKeyDid,
      attestation: {
        sig: attestation.sig,
        signingKey: attestation.signingKey,
      },
      createdAt: new Date().toISOString(),
    },
  })
}
