import type { Router, Request, Response } from 'express'
import type { AppContext } from '../../context.js'
import type { DpopAuthResult } from '../../auth/dpop-verifier.js'

/**
 * Attempt optional authentication - returns auth result if present and valid, null otherwise
 */
async function tryAuthenticate(
  ctx: AppContext,
  req: Request,
  res: Response,
): Promise<DpopAuthResult | null> {
  if (!ctx.dpopVerifier) return null
  if (!req.headers.authorization) return null

  try {
    return await ctx.dpopVerifier.verify(
      {
        method: req.method,
        url: req.url,
        headers: req.headers as Record<string, string | string[] | undefined>,
      },
      res,
    )
  } catch (err) {
    // Invalid auth should still throw
    throw err
  }
}

/**
 * Register enrollment-related XRPC handlers
 */
export function registerEnrollmentHandlers(router: Router, ctx: AppContext) {
  // app.stratos.enrollment.status - Check enrollment status
  router.get(
    '/xrpc/app.stratos.enrollment.status',
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
            const boundaryValues = await ctx.enrollmentStore.getBoundaries(did)
            response.boundaries = boundaryValues.map((value) => ({ value }))
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
