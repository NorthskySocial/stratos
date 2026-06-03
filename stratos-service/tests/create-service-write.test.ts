import { describe, expect, it, vi } from 'vitest'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { createRecord } from '../src/api/records/create.js'
import type { AppContext } from '../src/context-types.js'

const CALLER_DID = 'did:plc:asuka'

function buildInput() {
  return {
    repo: CALLER_DID,
    collection: 'zone.stratos.feed.post',
    record: {
      $type: 'zone.stratos.feed.post',
      text: 'hello shinji',
      createdAt: new Date().toISOString(),
    },
  }
}

function buildContext(enrollment: unknown): AppContext {
  return {
    writeRateLimiter: { assertWriteAllowed: vi.fn() },
    enrollmentStore: { getEnrollment: vi.fn().mockResolvedValue(enrollment) },
    getActorSigningKey: vi.fn(),
  } as unknown as AppContext
}

describe('createRecord service-write rejection', () => {
  it('rejects writes from service enrollments with ServiceWriteForbidden', async () => {
    const ctx = buildContext({
      did: CALLER_DID,
      active: true,
      isService: true,
    })

    await expect(createRecord(ctx, buildInput(), CALLER_DID)).rejects.toThrow(
      InvalidRequestError,
    )
    await expect(
      createRecord(ctx, buildInput(), CALLER_DID),
    ).rejects.toMatchObject({ customErrorName: 'ServiceWriteForbidden' })

    expect(ctx.getActorSigningKey).not.toHaveBeenCalled()
  })

  it('rejects writes from non-enrolled callers with NotEnrolled', async () => {
    const ctx = buildContext(null)

    await expect(
      createRecord(ctx, buildInput(), CALLER_DID),
    ).rejects.toMatchObject({ customErrorName: 'NotEnrolled' })

    expect(ctx.getActorSigningKey).not.toHaveBeenCalled()
  })

  it('does not reject regular user enrollments before signing', async () => {
    const ctx = buildContext({
      did: CALLER_DID,
      active: true,
      isService: false,
    })
    ;(ctx.getActorSigningKey as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('signing-reached'),
    )

    // A regular enrollment passes the service/enrollment gates and proceeds to
    // signing, where our stub throws — proving it was not blocked earlier.
    await expect(createRecord(ctx, buildInput(), CALLER_DID)).rejects.toThrow(
      'signing-reached',
    )
    expect(ctx.getActorSigningKey).toHaveBeenCalledWith(CALLER_DID)
  })

  it('treats a user with empty pdsEndpoint as a user, not a service', async () => {
    const ctx = buildContext({
      did: CALLER_DID,
      active: true,
      isService: false,
      pdsEndpoint: '',
    })
    ;(ctx.getActorSigningKey as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('signing-reached'),
    )

    // Classification must derive from `isService`, never `pdsEndpoint`
    // emptiness — an empty-PDS user still proceeds to signing.
    await expect(createRecord(ctx, buildInput(), CALLER_DID)).rejects.toThrow(
      'signing-reached',
    )
    expect(ctx.getActorSigningKey).toHaveBeenCalledWith(CALLER_DID)
  })
})
