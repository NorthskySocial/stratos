import {
  StratosError,
  type BoundaryCatalogStore,
  type EnrollmentStoreReader,
  type ListEnrollmentsOptions,
  type StoredEnrollment,
} from '@northskysocial/stratos-core'
import type { EnrollmentRecord, EnrollmentStore } from '../../oauth/index.js'

type WrappedStore = EnrollmentStore & EnrollmentStoreReader

export class BoundaryUnavailableError extends StratosError {
  constructor() {
    super('The boundary is inactive or unavailable', 'BoundaryUnavailable')
  }
}

/** Keep stale enrollment caches from authorizing a deactivated boundary. */
export class ActiveBoundaryEnrollmentStore implements WrappedStore {
  constructor(
    private readonly inner: WrappedStore,
    private readonly catalog: BoundaryCatalogStore,
  ) {}

  async normalizeLegacyMemberships(
    serviceDid: string,
    enqueue: (did: string) => Promise<unknown>,
  ): Promise<void> {
    const active = await this.activeSet()
    for (;;) {
      const dids = await this.catalog.listLegacyMembers(serviceDid, 100)
      if (dids.length === 0) return
      for (const did of dids) {
        const boundaries = await this.inner.getBoundaries(did)
        const normalized = [
          ...new Set(
            boundaries.map((boundary) => {
              const qualified = `${serviceDid}/${boundary}`
              return active.has(qualified) ? qualified : boundary
            }),
          ),
        ]
        await enqueue(did)
        await this.inner.setBoundaries(did, normalized)
        await enqueue(did)
      }
    }
  }

  isEnrolled(did: string): Promise<boolean> {
    return this.inner.isEnrolled(did)
  }
  enrollmentCount(): Promise<number> {
    return this.inner.enrollmentCount()
  }

  async getEnrollment(did: string): Promise<EnrollmentRecord | null> {
    const enrollment = await this.inner.getEnrollment(did)
    if (!enrollment || !enrollment.boundaries) return enrollment
    return {
      ...enrollment,
      boundaries: await this.filterActive(enrollment.boundaries),
    }
  }

  async getBoundaries(did: string): Promise<string[]> {
    return this.filterActive(await this.inner.getBoundaries(did))
  }

  async listEnrollments(
    options?: ListEnrollmentsOptions,
  ): Promise<StoredEnrollment[]> {
    return this.filterRows(await this.inner.listEnrollments(options))
  }

  async listServiceEnrollments(
    options?: ListEnrollmentsOptions,
  ): Promise<StoredEnrollment[]> {
    return this.filterRows(await this.inner.listServiceEnrollments(options))
  }

  async listEnrollmentsByBoundary(
    boundary: string,
    options?: ListEnrollmentsOptions,
  ): Promise<StoredEnrollment[]> {
    if ((await this.catalog.get(boundary))?.status !== 'active') return []
    return this.filterRows(
      await this.inner.listEnrollmentsByBoundary(boundary, options),
    )
  }

  async enroll(record: EnrollmentRecord): Promise<void> {
    await this.requireActive(record.boundaries ?? [])
    await this.inner.enroll(record)
  }

  async setBoundaries(did: string, boundaries: string[]): Promise<void> {
    await this.requireActive(boundaries)
    await this.inner.setBoundaries(did, boundaries)
  }

  async addBoundary(did: string, boundary: string): Promise<void> {
    await this.requireActive([boundary])
    await this.inner.addBoundary(did, boundary)
  }

  removeBoundary(did: string, boundary: string): Promise<void> {
    return this.inner.removeBoundary(did, boundary)
  }
  unenroll(did: string): Promise<void> {
    return this.inner.unenroll(did)
  }

  async updateEnrollment(
    did: string,
    updates: Partial<Omit<EnrollmentRecord, 'did'>>,
  ): Promise<void> {
    if (updates.boundaries) await this.requireActive(updates.boundaries)
    await this.inner.updateEnrollment(did, updates)
  }

  async filterActive(boundaries: string[]): Promise<string[]> {
    const active = await this.activeSet()
    return boundaries.filter((boundary) => active.has(boundary))
  }

  private async requireActive(boundaries: string[]): Promise<void> {
    const active = await this.activeSet()
    if (boundaries.some((boundary) => !active.has(boundary)))
      throw new BoundaryUnavailableError()
  }

  private async activeSet(): Promise<Set<string>> {
    return new Set(
      (await this.catalog.list())
        .filter((d) => d.status === 'active')
        .map((d) => d.boundary),
    )
  }

  private async filterRows(
    rows: StoredEnrollment[],
  ): Promise<StoredEnrollment[]> {
    const active = await this.activeSet()
    return rows.map((row) =>
      row.boundaries
        ? { ...row, boundaries: row.boundaries.filter((b) => active.has(b)) }
        : row,
    )
  }
}
