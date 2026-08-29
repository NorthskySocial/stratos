import { describe, expect, it, vi } from 'vitest'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { updateRecord } from '../src/api/records/update.js'
import type { AppContext } from '../src/context-types.js'

const CALLER_DID = 'did:plc:rei-ayanami'

function buildInput() {
  return {
    repo: CALLER_DID,
    collection: 'zone.stratos.feed.post',
    rkey: 'abc123',
    record: {
      $type: 'zone.stratos.feed.post',
      text: 'hello shinji',
      createdAt: new Date().toISOString(),
    },
    // Skips validateWritableRecord so the test isolates the custody gate.
    validate: false,
  }
}

function buildContext(enrollment: unknown): AppContext {
  return {
    writeRateLimiter: { assertWriteAllowed: vi.fn() },
    enrollmentStore: { getEnrollment: vi.fn().mockResolvedValue(enrollment) },
    actorStore: { exists: vi.fn().mockResolvedValue(true) },
  } as unknown as AppContext
}

describe('updateRecord pds-custody rejection', () => {
  it('rejects an update from a pds-custody actor', async () => {
    const ctx = buildContext({
      did: CALLER_DID,
      active: true,
      isService: false,
      custody: 'pds',
    })

    await expect(updateRecord(ctx, buildInput(), CALLER_DID)).rejects.toThrow(
      InvalidRequestError,
    )
    await expect(
      updateRecord(ctx, buildInput(), CALLER_DID),
    ).rejects.toMatchObject({ customErrorName: 'PdsCustodyWriteForbidden' })
  })

  it('never reaches the repo, so no partial update is attempted', async () => {
    const ctx = buildContext({
      did: CALLER_DID,
      active: true,
      isService: false,
      custody: 'pds',
    })

    await expect(updateRecord(ctx, buildInput(), CALLER_DID)).rejects.toThrow()

    expect(ctx.actorStore.exists).not.toHaveBeenCalled()
  })

  it('allows a stratos-custody actor past the gate', async () => {
    const ctx = buildContext({
      did: CALLER_DID,
      active: true,
      isService: false,
      custody: 'stratos',
    })

    // The write fails later for unrelated reasons in this stub, but it must
    // get past the custody gate first.
    await expect(
      updateRecord(ctx, buildInput(), CALLER_DID),
    ).rejects.not.toMatchObject({
      customErrorName: 'PdsCustodyWriteForbidden',
    })
    expect(ctx.actorStore.exists).toHaveBeenCalledWith(CALLER_DID)
  })

  it('allows an enrollment stored before MM-03, which carries no custody', async () => {
    const ctx = buildContext({
      did: CALLER_DID,
      active: true,
      isService: false,
    })

    await expect(
      updateRecord(ctx, buildInput(), CALLER_DID),
    ).rejects.not.toMatchObject({
      customErrorName: 'PdsCustodyWriteForbidden',
    })
    expect(ctx.actorStore.exists).toHaveBeenCalledWith(CALLER_DID)
  })
})
