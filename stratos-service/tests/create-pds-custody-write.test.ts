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
    actorSigner: { getSignFn: vi.fn() },
  } as unknown as AppContext
}

describe('createRecord pds-custody rejection', () => {
  it('rejects a write from a pds-custody actor', async () => {
    const ctx = buildContext({
      did: CALLER_DID,
      active: true,
      isService: false,
      custody: 'pds',
    })

    await expect(createRecord(ctx, buildInput(), CALLER_DID)).rejects.toThrow(
      InvalidRequestError,
    )
    await expect(
      createRecord(ctx, buildInput(), CALLER_DID),
    ).rejects.toMatchObject({ customErrorName: 'PdsCustodyWriteForbidden' })
  })

  it('never reaches the signer, so no Stratos key is minted', async () => {
    const ctx = buildContext({
      did: CALLER_DID,
      active: true,
      isService: false,
      custody: 'pds',
    })

    await expect(createRecord(ctx, buildInput(), CALLER_DID)).rejects.toThrow()

    // `getSignFn` creates a key when none exists. Reaching it at all would
    // give the actor a second signing key that no attestation covers.
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
      createRecord(ctx, buildInput(), CALLER_DID),
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
      createRecord(ctx, buildInput(), CALLER_DID),
    ).rejects.not.toMatchObject({
      customErrorName: 'PdsCustodyWriteForbidden',
    })
    expect(ctx.actorSigner.getSignFn).toHaveBeenCalledWith(CALLER_DID)
  })
})
