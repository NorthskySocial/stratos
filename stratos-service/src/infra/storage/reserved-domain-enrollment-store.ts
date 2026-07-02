import type {
  EnrollmentStoreReader,
  ListEnrollmentsOptions,
  StoredEnrollment,
} from '@northskysocial/stratos-core'
import type { EnrollmentRecord, EnrollmentStore } from '../../oauth/index.js'

/** The enrollment store surface used at the wiring site. */
type WrappedStore = EnrollmentStore & EnrollmentStoreReader

/**
 * Add a value to a boundary list if not already present, preserving order.
 *
 * @param boundaries - Existing boundaries.
 * @param reserved - The reserved domain to force-include.
 * @returns Boundaries guaranteed to contain the reserved domain.
 */
function withReserved(boundaries: string[], reserved: string): string[] {
  return boundaries.includes(reserved) ? boundaries : [...boundaries, reserved]
}

/**
 * Enrollment-store decorator that force-includes the reserved all-members
 * domain in every enrollment's boundary set and prevents its removal.
 *
 * This is the single chokepoint for the reserved-domain invariant: it wraps the
 * backend enrollment writer (SQLite or Postgres) so that ALL write paths — user
 * OAuth enrollment, the config-driven service reconciler, and admin boundary
 * edits — uniformly grant the reserved domain, with no per-call-site logic.
 *
 * Policy for a boundary update attempting to drop the reserved domain: it is
 * SILENTLY RE-ADDED (`setBoundaries` re-includes it; `removeBoundary` on the
 * reserved domain is a no-op). This matches the enrollment layer's forgiving,
 * idempotent update style rather than raising an error.
 */
export class ReservedDomainEnrollmentStore implements WrappedStore {
  constructor(
    private readonly inner: WrappedStore,
    private readonly reservedDomain: string,
  ) {}

  // ─── Reads (delegated) ────────────────────────────────────────────────

  isEnrolled(did: string): Promise<boolean> {
    return this.inner.isEnrolled(did)
  }

  getEnrollment(did: string): Promise<EnrollmentRecord | null> {
    return this.inner.getEnrollment(did)
  }

  getBoundaries(did: string): Promise<string[]> {
    return this.inner.getBoundaries(did)
  }

  listEnrollments(
    options?: ListEnrollmentsOptions,
  ): Promise<StoredEnrollment[]> {
    return this.inner.listEnrollments(options)
  }

  listServiceEnrollments(
    options?: ListEnrollmentsOptions,
  ): Promise<StoredEnrollment[]> {
    return this.inner.listServiceEnrollments(options)
  }

  enrollmentCount(): Promise<number> {
    return this.inner.enrollmentCount()
  }

  // ─── Writes (force-include the reserved domain) ───────────────────────

  enroll(record: EnrollmentRecord): Promise<void> {
    return this.inner.enroll({
      ...record,
      boundaries: withReserved(record.boundaries ?? [], this.reservedDomain),
    })
  }

  setBoundaries(did: string, boundaries: string[]): Promise<void> {
    return this.inner.setBoundaries(
      did,
      withReserved(boundaries, this.reservedDomain),
    )
  }

  addBoundary(did: string, boundary: string): Promise<void> {
    return this.inner.addBoundary(did, boundary)
  }

  removeBoundary(did: string, boundary: string): Promise<void> {
    // The reserved domain cannot be removed; silently ignore the request.
    if (boundary === this.reservedDomain) return Promise.resolve()
    return this.inner.removeBoundary(did, boundary)
  }

  // ─── Passthrough writes ───────────────────────────────────────────────

  unenroll(did: string): Promise<void> {
    return this.inner.unenroll(did)
  }

  updateEnrollment(
    did: string,
    updates: Partial<Omit<EnrollmentRecord, 'did'>>,
  ): Promise<void> {
    return this.inner.updateEnrollment(did, updates)
  }
}
