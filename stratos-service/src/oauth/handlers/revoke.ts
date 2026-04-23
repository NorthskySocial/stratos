import express from 'express'
import { Agent } from '@atproto/api'
import type { OAuthRoutesConfig } from '../routes.js'
import { serviceDIDToRkey } from '../routes.js'

export const handleRevoke = (
  config: OAuthRoutesConfig,
  authenticateRequest: (
    req: express.Request,
    res: express.Response,
  ) => Promise<string | null>,
) => {
  const { oauthClient, enrollmentStore, serviceDid, logger } = config

  return async (req: express.Request, res: express.Response) => {
    try {
      const did = await authenticateRequest(req, res)
      if (!did) return

      // Check if enrolled
      const currentEnrollment = await enrollmentStore.getEnrollment(did)
      if (!currentEnrollment) {
        return res.status(404).json({
          error: 'NotFound',
          message: 'User is not enrolled',
        })
      }

      // Best-effort PDS enrollment record deletion using stored rkey or service DID
      const rkey =
        currentEnrollment.enrollmentRkey || serviceDIDToRkey(serviceDid)
      try {
        const oauthSession = await oauthClient.restore(did)
        const agent = new Agent(oauthSession)
        await agent.com.atproto.repo.deleteRecord({
          repo: did,
          collection: 'zone.stratos.actor.enrollment',
          rkey,
        })
      } catch (err) {
        logger?.warn(
          { err: err instanceof Error ? err.message : String(err), did },
          'failed to delete PDS enrollment record',
        )
      }

      // Remove boundaries and mark enrollment inactive (signing key is preserved)
      await enrollmentStore.unenroll(did)

      // Revoke the OAuth session if client available
      if (oauthClient) {
        try {
          await oauthClient.revoke(did)
        } catch (err) {
          logger?.warn(
            { err: err instanceof Error ? err.message : String(err), did },
            'failed to revoke OAuth session',
          )
        }
      }

      logger?.info({ did }, 'user unenrolled via OAuth')

      res.json({
        did,
        revoked: true,
        message: 'Successfully unenrolled from Stratos',
      })
    } catch (err) {
      logger?.error(
        { err: err instanceof Error ? err.message : String(err) },
        'revoke failed',
      )
      res.status(500).json({
        error: 'RevokeError',
        message: 'Failed to revoke enrollment',
      })
    }
  }
}
