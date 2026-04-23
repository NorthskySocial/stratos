import express from 'express'
import type { OAuthRoutesConfig } from '../routes.js'

export const handleStatus = (
  config: OAuthRoutesConfig,
  authenticateRequest: (
    req: express.Request,
    res: express.Response,
  ) => Promise<string | null>,
) => {
  const { enrollmentStore, logger } = config

  return async (req: express.Request, res: express.Response) => {
    try {
      const did = await authenticateRequest(req, res)
      if (!did) return

      // Check enrollment status
      const enrollment = await enrollmentStore.getEnrollment(did)

      if (!enrollment) {
        return res.json({
          did,
          enrolled: false,
        })
      }

      const boundaries = await enrollmentStore.getBoundaries(did)
      res.json({
        did,
        enrolled: true,
        enrolledAt: enrollment.enrolledAt,
        boundaries: boundaries.map((value: string) => ({ value })),
      })
    } catch (err) {
      logger?.error(
        { err: err instanceof Error ? err.message : String(err) },
        'status check failed',
      )
      res.status(500).json({
        error: 'StatusError',
        message: 'Failed to check status',
      })
    }
  }
}
