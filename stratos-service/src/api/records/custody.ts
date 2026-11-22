import { InvalidRequestError } from '@atproto/xrpc-server'
import {
  PdsCustodyWriteForbiddenError,
  type StoredEnrollment,
} from '@northskysocial/stratos-core'
import type { AppContext } from '../../context.js'
import { authorizeBoundary } from './validation.js'

export function assertStratosCustody(
  enrollment: Pick<StoredEnrollment, 'custody'> | null | undefined,
): void {
  if (enrollment?.custody === 'pds') {
    throw new PdsCustodyWriteForbiddenError()
  }
}

export function assertWritableEnrollment(
  enrollment: StoredEnrollment | null | undefined,
): asserts enrollment is StoredEnrollment {
  if (!enrollment || !enrollment.active) {
    throw new InvalidRequestError(
      'User is not enrolled in this Stratos service',
      'NotEnrolled',
    )
  }
  // Service enrollments are read-only: they may subscribe and hydrate within
  // their boundaries but must not write records. Classification uses the
  // explicit `isService` flag, never `pdsEndpoint` emptiness.
  if (enrollment.isService) {
    throw new InvalidRequestError(
      'Service identities cannot create records',
      'ServiceWriteForbidden',
    )
  }
}

/**
 * Re-reads the writer's standing once the repo lock is held, so a change that
 * lands after the up-front checks still stops the write. The lock is held per
 * instance. The enrollment is read live, so a hold from any instance is seen.
 * Boundaries come from the write cache: a removal on this instance clears it,
 * but a removal on another instance can take up to the cache's 60 seconds.
 */
export async function assertWriterStillAuthorized(
  ctx: AppContext,
  callerDid: string,
  boundary: string,
): Promise<void> {
  const enrollment = await ctx.enrollmentStore.getEnrollment(callerDid)
  assertWritableEnrollment(enrollment)
  assertStratosCustody(enrollment)
  await authorizeBoundary(ctx, callerDid, boundary)
}
