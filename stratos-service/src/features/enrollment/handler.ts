import type { Router, Request, Response } from 'express'
import type { AppContext } from '../../context.js'

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

        ctx.logger?.debug(
          { method: 'enrollment.status', did },
          'handling request',
        )

        const enrollment = await ctx.enrollmentService.getEnrollment(did)

        ctx.logger?.debug(
          {
            did,
            enrolled: enrollment !== null,
            durationMs: Date.now() - start,
          },
          'enrollment status checked',
        )

        res.json({
          did,
          enrolled: enrollment !== null,
          enrolledAt: enrollment?.enrolledAt.toISOString(),
        })
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
