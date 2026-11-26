import { InvalidRequestError } from '@atproto/xrpc-server'
import {
  PdsCustodyWriteForbiddenError,
  type StoredEnrollment,
} from '@northskysocial/stratos-core'
import type { AppContext } from '../../context.js'
import { assertBoundaryStillHeld } from './validation.js'

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
 * instance, so both reads go to the store, never to a cache: a hold or a
 * boundary removal made on any instance stops the write. The up-front check
 * reads boundaries from the write cache; a stale entry there can only let a
 * write reach this check, never past it.
 */
export async function assertWriterStillAuthorized(
  ctx: AppContext,
  callerDid: string,
  boundary: string,
): Promise<void> {
  await assertWriterStillHoldsBoundaries(ctx, callerDid, [boundary])
}

/**
 * The check of {@link assertWriterStillAuthorized} for a write that touches
 * several boundaries, or none: a delete names no boundary, so it is judged
 * against every boundary the record is stored in. The standing is checked even
 * when there is no boundary to hold.
 */
export async function assertWriterStillHoldsBoundaries(
  ctx: AppContext,
  callerDid: string,
  boundaries: readonly string[],
): Promise<void> {
  const enrollment = await ctx.enrollmentStore.getEnrollment(callerDid)
  assertWritableEnrollment(enrollment)
  assertStratosCustody(enrollment)
  for (const boundary of boundaries) {
    await assertBoundaryStillHeld(ctx, callerDid, boundary)
  }
}
