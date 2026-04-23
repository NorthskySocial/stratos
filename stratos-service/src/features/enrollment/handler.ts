import { type Request, type Response } from 'express'
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
}

/**
 * Register handler for adding a boundary
 * @param ctx - Application context
 */
function registerAddBoundaryHandler(ctx: AppContext): void {
  ctx.app.post(
    '/xrpc/zone.stratos.admin.addBoundary',
    async (req: Request, res: Response) => {
      try {
        await ctx.authVerifier.admin({ req, res } as Parameters<
          typeof ctx.authVerifier.admin
        >[0])
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

        await ctx.enrollmentStore.addBoundary(did, boundary)
        const boundaries = await ctx.enrollmentStore.getBoundaries(did)

        try {
          await updatePdsEnrollmentRecord(ctx, did, boundaries)
        } catch (err) {
          ctx.logger?.warn(
            { err: err instanceof Error ? err.message : String(err), did },
            'failed to update PDS enrollment record after addBoundary',
          )
        }

        ctx.logger?.info({ did, boundary }, 'admin added boundary')
        res.json({ did, boundaries })
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
    async (req: Request, res: Response) => {
      try {
        await ctx.authVerifier.admin({ req, res } as Parameters<
          typeof ctx.authVerifier.admin
        >[0])
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

        await ctx.enrollmentStore.removeBoundary(did, boundary)
        const boundaries = await ctx.enrollmentStore.getBoundaries(did)

        try {
          await updatePdsEnrollmentRecord(ctx, did, boundaries)
        } catch (err) {
          ctx.logger?.warn(
            { err: err instanceof Error ? err.message : String(err), did },
            'failed to update PDS enrollment record after removeBoundary',
          )
        }

        ctx.logger?.info({ did, boundary }, 'admin removed boundary')
        res.json({ did, boundaries })
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
    async (req: Request, res: Response) => {
      try {
        await ctx.authVerifier.admin({ req, res } as Parameters<
          typeof ctx.authVerifier.admin
        >[0])
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

        await ctx.enrollmentStore.setBoundaries(did, boundaries)

        try {
          await updatePdsEnrollmentRecord(ctx, did, boundaries)
        } catch (err) {
          ctx.logger?.warn(
            { err: err instanceof Error ? err.message : String(err), did },
            'failed to update PDS enrollment record after setBoundaries',
          )
        }

        ctx.logger?.info(
          { did, boundaryCount: boundaries.length },
          'admin set boundaries',
        )
        res.json({ did, boundaries })
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
