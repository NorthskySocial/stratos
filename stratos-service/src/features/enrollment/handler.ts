import type { Router, Request, Response } from 'express'
import type { AppContext } from '../../context.js'

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
  // app.northsky.stratos.enrollment.status - Check enrollment status
  router.get(
    '/xrpc/app.northsky.stratos.enrollment.status',
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
            boundaries?: Array<{ value: string }>
          } = {
            did,
            enrolled: true,
            enrolledAt: enrollment.enrolledAt.toISOString(),
          }

          // Only include boundaries if authenticated
          if (auth) {
            const boundaryValues = await ctx.boundaryResolver.getBoundaries(did)
            response.boundaries = boundaryValues.map((value: string) => ({
              value,
            }))
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
}
