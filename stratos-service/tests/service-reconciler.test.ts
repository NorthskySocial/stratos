import type {
  EnrollmentStoreWriter,
  ServiceEnrollment,
  StoredEnrollment,
} from '@northskysocial/stratos-core'
import { beforeEach, describe, expect, it } from 'vitest'

import { reconcileServiceEnrollments } from '../src/features/enrollment/index.js'

/**
 * Minimal in-memory enrollment store writer for reconciler unit tests.
 * Only the methods exercised by the reconciler are implemented; the rest
 * throw so unexpected usage surfaces immediately.
 */
class FakeEnrollmentStore implements EnrollmentStoreWriter {
  readonly enrollments = new Map<string, StoredEnrollment>()

  async isEnrolled(did: string): Promise<boolean> {
    return this.enrollments.has(did)
  }

  async getEnrollment(did: string): Promise<StoredEnrollment | null> {
    return this.enrollments.get(did) ?? null
  }

  async listEnrollments(): Promise<StoredEnrollment[]> {
    return [...this.enrollments.values()]
  }

  async listActiveEnrollments(): Promise<StoredEnrollment[]> {
    return [...this.enrollments.values()].filter(
      (enrollment) => enrollment.active,
    )
  }

  async listServiceEnrollments(): Promise<StoredEnrollment[]> {
    return [...this.enrollments.values()].filter((e) => e.isService === true)
  }

  async listEnrollmentsByBoundary(
    boundary: string,
  ): Promise<StoredEnrollment[]> {
    return [...this.enrollments.values()].filter(
      (e) => e.active && (e.boundaries ?? []).includes(boundary),
    )
  }

  async enrollmentCount(): Promise<number> {
    return this.enrollments.size
  }

  async getBoundaries(did: string): Promise<string[]> {
    return this.enrollments.get(did)?.boundaries ?? []
  }

  async enroll(enrollment: StoredEnrollment): Promise<void> {
    this.enrollments.set(enrollment.did, { ...enrollment })
  }

  async unenroll(did: string): Promise<void> {
    this.enrollments.delete(did)
  }

  async updateEnrollment(
    did: string,
    updates: Partial<Omit<StoredEnrollment, 'did'>>,
  ): Promise<void> {
    const existing = this.enrollments.get(did)
    if (!existing) throw new Error(`no enrollment for ${did}`)
    this.enrollments.set(did, { ...existing, ...updates })
  }

  async setBoundaries(did: string, boundaries: string[]): Promise<void> {
    const existing = this.enrollments.get(did)
    if (!existing) throw new Error(`no enrollment for ${did}`)
    this.enrollments.set(did, { ...existing, boundaries: [...boundaries] })
  }

  async addBoundary(): Promise<void> {
    throw new Error('not implemented')
  }

  async removeBoundary(): Promise<void> {
    throw new Error('not implemented')
  }
}

const SIGNING_KEY_DID = 'did:key:z6MkSpike'

describe('reconcileServiceEnrollments', () => {
  let store: FakeEnrollmentStore

  beforeEach(() => {
    store = new FakeEnrollmentStore()
  })

  it('creates a new service enrollment when none exists', async () => {
    const enrollments: ServiceEnrollment[] = [
      { did: 'did:web:spiegel.appview', boundaries: ['did:web:host/eng'] },
    ]

    await reconcileServiceEnrollments(enrollments, {
      store,
      signingKeyDid: SIGNING_KEY_DID,
    })

    const stored = await store.getEnrollment('did:web:spiegel.appview')
    expect(stored).not.toBeNull()
    expect(stored?.isService).toBe(true)
    expect(stored?.active).toBe(true)
    expect(stored?.signingKeyDid).toBe(SIGNING_KEY_DID)
    expect(stored?.boundaries).toEqual(['did:web:host/eng'])
  })

  it('marks an existing enrollment as an active service enrollment', async () => {
    await store.enroll({
      did: 'did:web:vash.appview',
      enrolledAt: '2024-01-01T00:00:00.000Z',
      boundaries: ['did:web:host/old'],
      signingKeyDid: 'did:key:zStale',
      active: false,
      isService: false,
    })

    await reconcileServiceEnrollments(
      [{ did: 'did:web:vash.appview', boundaries: ['did:web:host/eng'] }],
      { store, signingKeyDid: SIGNING_KEY_DID },
    )

    const stored = await store.getEnrollment('did:web:vash.appview')
    expect(stored?.active).toBe(true)
    expect(stored?.isService).toBe(true)
    expect(stored?.signingKeyDid).toBe(SIGNING_KEY_DID)
    expect(stored?.boundaries).toEqual(['did:web:host/eng'])
    // The existing enrollment is updated in place, not re-created, so its
    // original enrolledAt timestamp is preserved.
    expect(stored?.enrolledAt).toBe('2024-01-01T00:00:00.000Z')
  })

  it('replaces boundaries with exactly those declared in config', async () => {
    await store.enroll({
      did: 'did:web:knives.appview',
      enrolledAt: '2024-01-01T00:00:00.000Z',
      boundaries: ['did:web:host/a', 'did:web:host/b', 'did:web:host/c'],
      signingKeyDid: SIGNING_KEY_DID,
      active: true,
      isService: true,
    })

    await reconcileServiceEnrollments(
      [{ did: 'did:web:knives.appview', boundaries: ['did:web:host/a'] }],
      { store, signingKeyDid: SIGNING_KEY_DID },
    )

    expect(await store.getBoundaries('did:web:knives.appview')).toEqual([
      'did:web:host/a',
    ])
  })

  it('is idempotent across repeated runs', async () => {
    const enrollments: ServiceEnrollment[] = [
      { did: 'did:web:meryl.appview', boundaries: ['did:web:host/eng'] },
    ]

    await reconcileServiceEnrollments(enrollments, {
      store,
      signingKeyDid: SIGNING_KEY_DID,
    })
    await reconcileServiceEnrollments(enrollments, {
      store,
      signingKeyDid: SIGNING_KEY_DID,
    })

    expect(await store.enrollmentCount()).toBe(1)
    const stored = await store.getEnrollment('did:web:meryl.appview')
    expect(stored?.boundaries).toEqual(['did:web:host/eng'])
  })

  it('reconciles multiple enrollments', async () => {
    await reconcileServiceEnrollments(
      [
        { did: 'did:web:wolfwood.appview', boundaries: ['did:web:host/eng'] },
        { did: 'did:web:legato.appview', boundaries: ['did:web:host/ops'] },
      ],
      { store, signingKeyDid: SIGNING_KEY_DID },
    )

    expect(await store.enrollmentCount()).toBe(2)
    expect(await store.getBoundaries('did:web:wolfwood.appview')).toEqual([
      'did:web:host/eng',
    ])
    expect(await store.getBoundaries('did:web:legato.appview')).toEqual([
      'did:web:host/ops',
    ])
  })

  it('logs a reconciliation entry per enrollment with the boundary count', async () => {
    const entries: Array<{ obj: unknown; msg: string }> = []
    const logger = {
      info: (obj: unknown, msg: string) => entries.push({ obj, msg }),
      warn: () => {},
      error: () => {},
      debug: () => {},
    }

    await reconcileServiceEnrollments(
      [
        {
          did: 'did:web:nico.appview',
          boundaries: ['did:web:host/eng', 'did:web:host/ops'],
        },
      ],
      { store, signingKeyDid: SIGNING_KEY_DID, logger: logger as never },
    )

    expect(entries).toHaveLength(1)
    expect(entries[0].msg).toBe('reconciled service enrollment')
    expect(entries[0].obj).toEqual({
      did: 'did:web:nico.appview',
      boundaries: 2,
    })
  })

  it('prunes service rows no longer declared in config', async () => {
    await store.enroll({
      did: 'did:web:stale.appview',
      enrolledAt: '2024-01-01T00:00:00.000Z',
      boundaries: ['did:web:host/old'],
      signingKeyDid: SIGNING_KEY_DID,
      active: true,
      isService: true,
    })

    await reconcileServiceEnrollments(
      [{ did: 'did:web:fresh.appview', boundaries: ['did:web:host/eng'] }],
      { store, signingKeyDid: SIGNING_KEY_DID },
    )

    expect(await store.getEnrollment('did:web:stale.appview')).toBeNull()
    expect(await store.getEnrollment('did:web:fresh.appview')).not.toBeNull()
  })

  it('does not prune non-service (user) enrollments', async () => {
    await store.enroll({
      did: 'did:web:milly.user',
      enrolledAt: '2024-01-01T00:00:00.000Z',
      pdsEndpoint: 'https://pds.example.com',
      boundaries: ['did:web:host/eng'],
      signingKeyDid: 'did:key:zUserKey',
      active: true,
      isService: false,
    })

    await reconcileServiceEnrollments([], {
      store,
      signingKeyDid: SIGNING_KEY_DID,
    })

    expect(await store.getEnrollment('did:web:milly.user')).not.toBeNull()
  })

  it('logs a prune entry for each stale service row', async () => {
    await store.enroll({
      did: 'did:web:stale.appview',
      enrolledAt: '2024-01-01T00:00:00.000Z',
      boundaries: ['did:web:host/old'],
      signingKeyDid: SIGNING_KEY_DID,
      active: true,
      isService: true,
    })

    const entries: Array<{ obj: unknown; msg: string }> = []
    const logger = {
      info: (obj: unknown, msg: string) => entries.push({ obj, msg }),
      warn: () => {},
      error: () => {},
      debug: () => {},
    }

    await reconcileServiceEnrollments([], {
      store,
      signingKeyDid: SIGNING_KEY_DID,
      logger: logger as never,
    })

    expect(entries).toHaveLength(1)
    expect(entries[0].msg).toBe('pruned stale service enrollment')
    expect(entries[0].obj).toEqual({ did: 'did:web:stale.appview' })
  })
})
