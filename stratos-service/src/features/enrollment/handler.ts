import type { Router, Request, Response } from 'express'
import type { BoundaryResolver } from '@northskysocial/stratos-core'
import type { AppContext } from '../../context.js'

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

/**
 * Attempt optional authentication
 * Returns the authenticated DID if present and valid, null otherwise.
 */
async function tryAuthenticate(
  ctx: AppContext,
  req: Request,
  res: Response,
): Promise<string | null> {
  try {
    const result = await ctx.authVerifier.optionalStandard({
      req,
      res,
    } as Parameters<typeof ctx.authVerifier.optionalStandard>[0])
    return result.credentials.did ?? null
  } catch {
    return null
  }
}

/**
 * Register enrollment-related XRPC handlers
 */
export function registerEnrollmentHandlers(router: Router, ctx: AppContext) {
  // zone.stratos.enrollment.status - Check enrollment status
  router.get(
    '/xrpc/zone.stratos.enrollment.status',
    async (req: Request, res: Response) => {
      const start = Date.now()
      try {
        const { did } = req.query as { did: string }

        if (!did) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: 'did parameter required',
          })
        }

        // Attempt optional authentication
        const auth = await tryAuthenticate(ctx, req, res)

        ctx.logger?.debug(
          { method: 'enrollment.status', did, authenticated: !!auth },
          'handling request',
        )

        const enrollment = await ctx.enrollmentService.getEnrollment(did)

        // This isn't a super great way to do it but hiding boundaries unless authenticated prevents abuse
        if (enrollment) {
          const response: {
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

          // Only include boundaries if authenticated
          if (auth) {
            const boundaryValues = await ctx.boundaryResolver.getBoundaries(did)
            response.boundaries = boundaryValues.map((value: string) => ({
              value,
            }))

            if (boundaryValues.length > 0) {
              try {
                response.attestation = await ctx.createAttestation(
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
              authenticated: !!auth,
              boundaryCount: response.boundaries?.length ?? 0,
              durationMs: Date.now() - start,
            },
            'enrollment status checked',
          )

          res.json(response)
        } else {
          ctx.logger?.debug(
            {
              did,
              enrolled: false,
              durationMs: Date.now() - start,
            },
            'enrollment status checked',
          )

          res.json({
            did,
            enrolled: false,
          })
        }
      } catch (err) {
        ctx.logger?.error(
          {
            err: err instanceof Error ? err.message : String(err),
            did: req.query.did,
          },
          'enrollment.status failed',
        )
        res.status(500).json({
          error: 'InternalError',
          message: 'Failed to check enrollment status',
        })
      }
    },
  )

  // zone.stratos.identity.resolveEnrollments — unauthenticated boundary lookup
  const cachedResolver = new CachedBoundaryResolver(ctx.boundaryResolver)

  router.get(
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
}
