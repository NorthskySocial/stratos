import { describe, expect, it, vi } from 'vitest'
import {
  EnrollmentDeniedError,
  type EnrollmentStoreReader,
} from '@northskysocial/stratos-core'
import { verifyEnrolled } from '../src/features/enrollment/internal/auth.js'

function deps(enrollment: unknown) {
  return {
    idResolver: {} as never,
    enrollmentStore: {
      getEnrollment: vi.fn(async () => enrollment),
    } as unknown as EnrollmentStoreReader,
    // Enrollment is closed, so an unenrolled DID is denied rather than
    // auto-enrolled; this isolates the active check.
    config: { open: false, allowList: [] } as never,
    logger: { warn: vi.fn(), error: vi.fn() } as never,
  }
}

const ENROLLED = {
  did: 'did:plc:usagi',
  enrolledAt: '2026-01-01T00:00:00.000Z',
  signingKeyDid: 'did:key:zSailorMoon',
  active: true,
}

describe('verifyEnrolled', () => {
  it('admits an active member', async () => {
    await expect(
      verifyEnrolled('did:plc:usagi', deps(ENROLLED)),
    ).resolves.toBeUndefined()
  })

  it('denies a deactivated member', async () => {
    await expect(
      verifyEnrolled('did:plc:usagi', deps({ ...ENROLLED, active: false })),
    ).rejects.toBeInstanceOf(EnrollmentDeniedError)
  })

  it('does not readmit a deactivated member through auto-enrollment', async () => {
    // Enrollment open to everyone: without the active check, the deactivated
    // member would fall through and be readmitted.
    const openDeps = {
      ...deps({ ...ENROLLED, active: false }),
      config: { open: true, allowList: [] } as never,
    }

    await expect(
      verifyEnrolled('did:plc:usagi', openDeps),
    ).rejects.toBeInstanceOf(EnrollmentDeniedError)
  })
})
