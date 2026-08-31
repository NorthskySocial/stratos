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
