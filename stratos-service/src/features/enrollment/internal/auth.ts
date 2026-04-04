import { type IdResolver } from '@atproto/identity'
import {
  type EnrollmentConfig,
  EnrollmentDeniedError,
  type EnrollmentStoreReader,
  type Logger,
} from '@northskysocial/stratos-core'
import { type AllowListProvider } from './allow-list.js'
import { assertEnrollment } from './validation.js'

export interface EnrollmentAuthDeps {
  idResolver: IdResolver
  enrollmentStore: EnrollmentStoreReader
  config: EnrollmentConfig
  allowListProvider?: AllowListProvider
  logger?: Logger
}

/**
 * Verify that a DID is enrolled in the service.
 *
 * @param did - DID to verify
 * @param deps - Dependencies for enrollment verification
 */
export async function verifyEnrolled(
  did: string,
  deps: EnrollmentAuthDeps,
): Promise<void> {
  const isEnrolled = await deps.enrollmentStore.getEnrollment(did)
  if (isEnrolled) {
    return
  }

  // Not in our DB, check if they are eligible for auto-enrollment
  try {
    await assertEnrollment(
      deps.config,
      did,
      deps.idResolver,
      deps.allowListProvider,
    )
  } catch (err) {
    if (err instanceof EnrollmentDeniedError) {
      throw err
    }
    deps.logger?.error({ err, did }, 'failed to verify enrollment eligibility')
    throw new EnrollmentDeniedError(
      'Enrollment verification failed',
      'NotInAllowlist',
      { cause: err },
    )
  }
}
