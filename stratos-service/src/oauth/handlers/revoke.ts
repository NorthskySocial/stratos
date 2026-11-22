import express from 'express'
import { Agent } from '@atproto/api'
import type { StoredEnrollment } from '@northskysocial/stratos-core'
import type { OAuthRoutesConfig } from '../routes.js'
import { INACTIVE_ENROLLMENT_DENIED_BODY } from '../enrollment-denied.js'
import { serviceDIDToRkey } from '../routes.js'
import { republishEnrollmentRecord } from '../../features/enrollment/republish.js'

type Revocable =
  | { enrollment: StoredEnrollment }
  | { refusal: { status: number; body: { error: string; message: string } } }

function checkRevocable(enrollment: StoredEnrollment | null): Revocable {
  if (!enrollment) {
    return {
      refusal: {
        status: 404,
        body: { error: 'NotFound', message: 'User is not enrolled' },
      },
    }
  }
  // Deleting a held member's row would drop the hold and let them enroll
  // again. The XRPC unenroll already refuses inactive members.
  if (enrollment.active === false) {
    return {
      refusal: {
        status: 403,
        body: INACTIVE_ENROLLMENT_DENIED_BODY,
      },
    }
  }
  return { enrollment }
}

// Best-effort PDS enrollment record deletion using stored rkey or service DID
async function deletePdsEnrollmentRecord(
  config: Pick<OAuthRoutesConfig, 'oauthClient' | 'serviceDid' | 'logger'>,
  did: string,
  enrollment: StoredEnrollment,
): Promise<void> {
  const rkey = enrollment.enrollmentRkey || serviceDIDToRkey(config.serviceDid)
  try {
    const oauthSession = await config.oauthClient.restore(did)
    const agent = new Agent(oauthSession)
    await agent.com.atproto.repo.deleteRecord({
      repo: did,
      collection: 'zone.stratos.actor.enrollment',
      rkey,
    })
  } catch (err) {
    config.logger?.warn(
      { err: err instanceof Error ? err.message : String(err), did },
      'failed to delete PDS enrollment record',
    )
  }
}

/**
 * Hold changes take the same per-DID lock, so a hold cannot land between this
 * check and the delete.
 */
async function unenrollIfRevocable(
  config: Pick<OAuthRoutesConfig, 'enrollmentStore' | 'repoWriteLocks'>,
  did: string,
): Promise<Revocable> {
  const release = await config.repoWriteLocks.acquire(did)
  try {
    const revocable = checkRevocable(
      await config.enrollmentStore.getEnrollment(did),
    )
    if ('enrollment' in revocable) await config.enrollmentStore.unenroll(did)
    return revocable
  } finally {
    release()
  }
}

export const handleRevoke = (
  config: OAuthRoutesConfig,
  authenticateRequest: (
    req: express.Request,
    res: express.Response,
  ) => Promise<string | null>,
) => {
  const { oauthClient, enrollmentStore, logger } = config

  return async (req: express.Request, res: express.Response) => {
    try {
      const did = await authenticateRequest(req, res)
      if (!did) return

      // Check if enrolled
      const revocable = checkRevocable(await enrollmentStore.getEnrollment(did))
      if ('refusal' in revocable) {
        return res.status(revocable.refusal.status).json(revocable.refusal.body)
      }
      await deletePdsEnrollmentRecord(config, did, revocable.enrollment)

      // A hold can land while the PDS call runs, so the check runs again. A
      // refusal then puts back the record that call deleted.
      const final = await unenrollIfRevocable(config, did)
      if ('refusal' in final) {
        await republishEnrollmentRecord(config, did)
        return res.status(final.refusal.status).json(final.refusal.body)
      }

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
