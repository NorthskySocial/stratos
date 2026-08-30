import { describe, expect, it, vi } from 'vitest'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { applyWritesBatch } from '../src/api/records/batch.js'
import type { BatchWriteOp } from '../src/api/records/batch.js'
import type { AppContext } from '../src/context-types.js'

const CALLER_DID = 'did:plc:motoko-kusanagi'

function buildOps(): BatchWriteOp[] {
  // A delete op skips validateWritableRecord inside calculatePrecomputed, so
  // the test isolates the custody gate instead of wiring up record validation.
  return [{ action: 'delete', collection: 'zone.stratos.feed.post', rkey: 'abc123' }]
}

function buildContext(enrollment: unknown): AppContext {
  return {
    writeRateLimiter: { assertWriteAllowed: vi.fn() },
    enrollmentStore: { getEnrollment: vi.fn().mockResolvedValue(enrollment) },
    actorSigner: { getSignFn: vi.fn() },
  } as unknown as AppContext
}

describe('applyWritesBatch pds-custody rejection', () => {
  it('rejects a batch write from a pds-custody actor', async () => {
    const ctx = buildContext({
      did: CALLER_DID,
      active: true,
      isService: false,
      custody: 'pds',
    })

    await expect(
      applyWritesBatch(ctx, CALLER_DID, buildOps()),
    ).rejects.toThrow(InvalidRequestError)
    await expect(
      applyWritesBatch(ctx, CALLER_DID, buildOps()),
    ).rejects.toMatchObject({
      customErrorName: 'PdsCustodyWriteForbidden',
      message: 'This actor writes records to their own PDS',
    })
  })

  it('never reaches the signer, so no Stratos key is minted', async () => {
    const ctx = buildContext({
      did: CALLER_DID,
      active: true,
      isService: false,
      custody: 'pds',
    })

    await expect(
      applyWritesBatch(ctx, CALLER_DID, buildOps()),
    ).rejects.toThrow()

    expect(ctx.actorSigner.getSignFn).not.toHaveBeenCalled()
  })

  it('allows a stratos-custody actor through to the signer', async () => {
    const ctx = buildContext({
      did: CALLER_DID,
      active: true,
      isService: false,
      custody: 'stratos',
    })

    // The write fails later for unrelated reasons in this stub, but it must
    // get past the custody gate first.
    await expect(
      applyWritesBatch(ctx, CALLER_DID, buildOps()),
    ).rejects.not.toMatchObject({
      customErrorName: 'PdsCustodyWriteForbidden',
    })
    expect(ctx.actorSigner.getSignFn).toHaveBeenCalledWith(CALLER_DID)
  })

  it('allows an enrollment stored before MM-03, which carries no custody', async () => {
    const ctx = buildContext({
      did: CALLER_DID,
      active: true,
      isService: false,
    })

    await expect(
      applyWritesBatch(ctx, CALLER_DID, buildOps()),
    ).rejects.not.toMatchObject({
      customErrorName: 'PdsCustodyWriteForbidden',
    })
    expect(ctx.actorSigner.getSignFn).toHaveBeenCalledWith(CALLER_DID)
  })
})
