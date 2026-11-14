import { InvalidRequestError } from '@atproto/xrpc-server'
import {
  PdsCustodyWriteForbiddenError,
  type StoredEnrollment,
} from '@northskysocial/stratos-core'

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
