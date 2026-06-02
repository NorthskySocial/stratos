import type {
  EnrollmentStoreWriter,
  Logger,
  ServiceEnrollment,
} from '@northskysocial/stratos-core'

/**
 * Dependencies for reconciling config-driven service enrollments.
 */
export interface ReconcileServiceEnrollmentsDeps {
  /** Enrollment store writer used to upsert service enrollments. */
  store: EnrollmentStoreWriter
  /** Service signing key DID recorded as the enrollment's signing key. */
  signingKeyDid: string
  logger?: Logger
}

/**
 * Reconcile config-declared service enrollments into the enrollment store.
 *
 * Configuration is the source of truth: each declared enrollment is upserted
 * with `isService = true` and its boundaries are set to exactly those declared.
 * Service rows that are no longer present in the configuration are pruned. The
 * operation is idempotent and safe to run on every startup.
 *
 * @param enrollments - Validated service enrollments from configuration.
 * @param deps - Store, signing key DID, and optional logger.
 */
export async function reconcileServiceEnrollments(
  enrollments: ServiceEnrollment[],
  deps: ReconcileServiceEnrollmentsDeps,
): Promise<void> {
  const { store, signingKeyDid, logger } = deps

  const declared = new Set<string>()

  for (const enrollment of enrollments) {
    declared.add(enrollment.did)

    const existing = await store.getEnrollment(enrollment.did)

    if (existing) {
      await store.updateEnrollment(enrollment.did, {
        active: true,
        isService: true,
        signingKeyDid,
      })
    } else {
      await store.enroll({
        did: enrollment.did,
        enrolledAt: new Date().toISOString(),
        pdsEndpoint: undefined,
        boundaries: enrollment.boundaries,
        signingKeyDid,
        active: true,
        isService: true,
      })
    }

    await store.setBoundaries(enrollment.did, enrollment.boundaries)

    logger?.info(
      { did: enrollment.did, boundaries: enrollment.boundaries.length },
      'reconciled service enrollment',
    )
  }

  const existingServices = await store.listServiceEnrollments({
    limit: Number.MAX_SAFE_INTEGER,
  })

  for (const service of existingServices) {
    if (declared.has(service.did)) continue

    await store.unenroll(service.did)

    logger?.info({ did: service.did }, 'pruned stale service enrollment')
  }
}
