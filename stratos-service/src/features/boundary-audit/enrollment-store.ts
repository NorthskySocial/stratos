import type {
  EnrollmentStoreWriter,
  ListEnrollmentsOptions,
  StoredEnrollment,
} from '@northskysocial/stratos-core'
import type { BoundaryAudit } from './audit.js'

export class AuditedEnrollmentStore implements EnrollmentStoreWriter {
  constructor(
    private readonly inner: EnrollmentStoreWriter,
    private readonly audit: BoundaryAudit,
  ) {}

  isEnrolled(did: string) {
    return this.inner.isEnrolled(did)
  }
  getEnrollment(did: string) {
    return this.inner.getEnrollment(did)
  }
  getBoundaries(did: string) {
    return this.inner.getBoundaries(did)
  }
  enrollmentCount() {
    return this.inner.enrollmentCount()
  }
  listEnrollments(options?: ListEnrollmentsOptions) {
    return this.inner.listEnrollments(options)
  }
  listServiceEnrollments(options?: ListEnrollmentsOptions) {
    return this.inner.listServiceEnrollments(options)
  }
  listEnrollmentsByBoundary(
    boundary: string,
    options?: ListEnrollmentsOptions,
  ) {
    return this.inner.listEnrollmentsByBoundary(boundary, options)
  }
  enroll(record: StoredEnrollment): Promise<void> {
    return this.audit.mutate(record.did, (store) => store.enroll(record))
  }
  unenroll(did: string): Promise<void> {
    return this.audit.mutate(did, (store) => store.unenroll(did))
  }
  updateEnrollment(
    did: string,
    updates: Partial<Omit<StoredEnrollment, 'did'>>,
  ): Promise<void> {
    const { boundaries, ...metadata } = updates
    return this.audit.mutate(did, async (store) => {
      await store.updateEnrollment(did, metadata)
      if (boundaries !== undefined) {
        await store.setBoundaries(did, [...new Set(boundaries)])
      }
    })
  }
  setBoundaries(did: string, boundaries: string[]): Promise<void> {
    return this.audit.mutate(did, (store) =>
      store.setBoundaries(did, [...new Set(boundaries)]),
    )
  }
  addBoundary(did: string, boundary: string): Promise<void> {
    return this.audit.mutate(did, (store) => store.addBoundary(did, boundary))
  }
  removeBoundary(did: string, boundary: string): Promise<void> {
    return this.audit.mutate(did, (store) =>
      store.removeBoundary(did, boundary),
    )
  }
}
