import express, { type Request, type Response } from 'express'
import type { BoundaryResolver } from '@northskysocial/stratos-core'
import { Agent } from '@atproto/api'
import {
  Server as XrpcServer,
  InvalidRequestError,
  AuthRequiredError,
} from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { serviceDIDToRkey } from '../../oauth/routes.js'

const jsonBody = express.json({ limit: '100kb' })

const BOUNDARY_CACHE_TTL_MS = 60_000

interface CacheEntry {
  boundaries: string[]
  expiresAt: number
}

export class CachedBoundaryResolver {
  private cache = new Map<string, CacheEntry>()

  constructor(private resolver: BoundaryResolver) {}

  async getBoundaries(did: string): Promise<string[]> {
    const now = Date.now()
    const cached = this.cache.get(did)
    if (cached && cached.expiresAt > now) {
      return cached.boundaries
    }
    const boundaries = await this.resolver.getBoundaries(did)
    this.cache.set(did, { boundaries, expiresAt: now + BOUNDARY_CACHE_TTL_MS })
    return boundaries
  }
}

type HandlerAuth = {
  credentials: {
    type: string
    did?: string
  }
}

type HandlerInput = {
  body?: unknown
}

type HandlerParams = Record<string, unknown>

type HandlerContext = {
  input?: HandlerInput
  params: HandlerParams
  auth?: HandlerAuth
}

type HandlerResponse = {
  encoding: string
  body: unknown
}

type HandlerFn = (ctx: HandlerContext) => Promise<HandlerResponse>

// Type for accessing internal method - needed until lexicons are properly loaded
type XrpcServerInternal = XrpcServer & {
  method(
    nsid: string,
    config: {
      auth?: (
        ctx: import('@atproto/xrpc-server').MethodAuthContext,
      ) => Promise<unknown>
      handler: HandlerFn
    },
  ): void
}

/**
 * Register enrollment-related XRPC handlers
 */
export function registerEnrollmentHandlers(
  server: XrpcServer,
  ctx: AppContext,
): void {
  const xrpc = server as unknown as XrpcServerInternal
  const { authVerifier } = ctx

  // zone.stratos.enrollment.status - Check enrollment status
  xrpc.method('zone.stratos.enrollment.status', {
    auth: authVerifier.optionalStandard,
    handler: async ({ params, auth }: HandlerContext) => {
      const start = Date.now()
      const did = params.did as string

      if (!did) {
        throw new InvalidRequestError(
          'did parameter required',
          'InvalidRequest',
        )
      }

      const typedAuth = auth as HandlerAuth | undefined
      const authenticatedDid = typedAuth?.credentials?.did

      ctx.logger?.debug(
        { method: 'enrollment.status', did, authenticated: !!authenticatedDid },
        'handling request',
      )

      const enrollment = await ctx.enrollmentService.getEnrollment(did)

      // This isn't a super great way to do it but hiding boundaries unless authenticated prevents abuse
      if (enrollment) {
        const body: {
          did: string
          enrolled: true
          enrolledAt: string
          active: boolean
          signingKey: string
          enrollmentRkey?: string
          boundaries?: Array<{ value: string }>
          attestation?: { sig: Uint8Array; signingKey: string }
        } = {
          did,
          enrolled: true,
          enrolledAt: enrollment.enrolledAt.toISOString(),
          active: enrollment.active,
          signingKey: enrollment.signingKeyDid,
          enrollmentRkey: enrollment.enrollmentRkey,
        }

          // Always resolve boundaries to trigger lazy migration for legacy bare-name boundaries.
          // Only include them in the response when authenticated to prevent enumeration abuse.
          const boundaryValues = await ctx.boundaryResolver.getBoundaries(did)

          if (authenticatedDid) {
            body.boundaries = boundaryValues.map((value: string) => ({
              value,
            }))

            if (boundaryValues.length > 0) {
              try {
                body.attestation = await ctx.createAttestation(
                  did,
                  boundaryValues,
                  enrollment.signingKeyDid,
                )
              } catch (err) {
                ctx.logger?.warn(
                  {
                    err: err instanceof Error ? err.message : String(err),
                    did,
                  },
                  'failed to generate attestation for status',
                )
              }
            }
          }

        ctx.logger?.debug(
          {
            did,
            enrolled: true,
            authenticated: !!authenticatedDid,
            boundaryCount: body.boundaries?.length ?? 0,
            durationMs: Date.now() - start,
          },
          'enrollment status checked',
        )

        return {
          encoding: 'application/json',
          body,
        }
      } else {
        ctx.logger?.debug(
          {
            did,
            enrolled: false,
            durationMs: Date.now() - start,
          },
          'enrollment status checked',
        )

        return {
          encoding: 'application/json',
          body: {
            did,
            enrolled: false,
          },
        }
      }
    },
  })

  // zone.stratos.enrollment.unenroll - Unenroll from Stratos
  xrpc.method('zone.stratos.enrollment.unenroll', {
    auth: authVerifier.standard,
    handler: async ({ auth }: HandlerContext) => {
      const start = Date.now()
      const typedAuth = auth as HandlerAuth | undefined
      const did = typedAuth?.credentials?.did

      if (!did) {
        throw new AuthRequiredError('Authentication required')
      }

      ctx.logger?.info(
        { did, method: 'enrollment.unenroll' },
        'handling unenrollment request',
      )

      // 1. Delete enrollment record from user's PDS (best-effort)
      try {
        const enrollment = await ctx.enrollmentStore.getEnrollment(did)
        if (enrollment?.enrollmentRkey) {
          await ctx.profileRecordWriter.deleteEnrollmentRecord(
            did,
            enrollment.enrollmentRkey,
          )
        }
      } catch (err) {
        ctx.logger?.warn(
          { err: err instanceof Error ? err.message : String(err), did },
          'failed to delete PDS enrollment record during unenrollment',
        )
      }

      // 2. Mark enrollment as inactive in local storage
      await ctx.enrollmentService.unenroll(did)

      // 3. Revoke OAuth sessions
      try {
        await ctx.oauthClient.revoke(did)
      } catch (err) {
        ctx.logger?.warn(
          { err: err instanceof Error ? err.message : String(err), did },
          'failed to revoke OAuth session during unenrollment',
        )
      }

      ctx.logger?.info(
        { did, durationMs: Date.now() - start },
        'user unenrolled successfully',
      )

      return {
        encoding: 'application/json',
        body: { success: true },
      }
    },
  })

  // zone.stratos.identity.resolveEnrollments — unauthenticated boundary lookup
  const cachedResolver = new CachedBoundaryResolver(ctx.boundaryResolver)

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

        const enrolled = await ctx.enrollmentService.isEnrolled(did)
        if (!enrolled) {
          return res.json({ did, enrolled: false, boundaries: [] })
        }

        const boundaries = await cachedResolver.getBoundaries(did)
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

  // ── Admin boundary management ──────────────────────────────────────────

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

  // POST /xrpc/zone.stratos.admin.addBoundary
  ctx.app.post(
    '/xrpc/zone.stratos.admin.addBoundary',
    jsonBody,
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

  // POST /xrpc/zone.stratos.admin.removeBoundary
  ctx.app.post(
    '/xrpc/zone.stratos.admin.removeBoundary',
    jsonBody,
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

  // POST /xrpc/zone.stratos.admin.setBoundaries
  ctx.app.post(
    '/xrpc/zone.stratos.admin.setBoundaries',
    jsonBody,
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

  // zone.stratos.server.listDomains — public service information
  ctx.app.get(
    '/xrpc/zone.stratos.server.listDomains',
    async (_req: Request, res: Response) => {
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
