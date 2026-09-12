import { describe, expect, it, vi } from 'vitest'
import { AuthRequiredError } from '@atproto/xrpc-server'
import type { AppContext } from '../src/context-types.js'
import {
  listBoundaryOpsHandler,
  getBoundaryAuditStateHandler,
  registerBoundaryAuditHandlers,
} from '../src/features/boundary-audit/handler.js'
import { BoundaryHistoryTruncatedError } from '../src/features/boundary-audit/model.js'

const DID = 'did:plc:rei'
const auth = { credentials: { type: 'admin', did: 'did:plc:misato' } }
function fixture() {
  const boundaryAudit = {
    list: vi.fn().mockResolvedValue({ operations: [] }),
    checkpoint: vi.fn().mockResolvedValue({ checkpoint: {} }),
  }
  const ctx = {
    boundaryAudit,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    authVerifier: { admin: vi.fn() },
  } as unknown as AppContext
  return { ctx, boundaryAudit }
}

describe('boundary audit handlers', () => {
  it('passes the actor and bounded page parameters to the audit reader', async () => {
    const { ctx, boundaryAudit } = fixture()
    const response = await listBoundaryOpsHandler(ctx)({
      auth,
      params: { did: DID, limit: 4, cursor: 'resume' },
    })
    expect(boundaryAudit.list).toHaveBeenCalledExactlyOnceWith(DID, 4, 'resume')
    expect(response).toEqual({
      encoding: 'application/json',
      body: { operations: [] },
    })
    await getBoundaryAuditStateHandler(ctx)({ auth, params: { did: DID } })
    expect(boundaryAudit.checkpoint).toHaveBeenCalledExactlyOnceWith(DID)
    expect(ctx.logger!.debug).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'zone.stratos.admin.listBoundaryOps' }),
      'handling request',
    )
    expect(ctx.logger!.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'zone.stratos.admin.getBoundaryAuditState',
      }),
      'handling request',
    )
  })

  it.each([
    undefined,
    { credentials: { type: 'standard', did: DID } },
    { credentials: { type: 'service', did: DID } },
  ])('rejects a non-admin principal %s', async (principal) => {
    const { ctx, boundaryAudit } = fixture()
    for (const handler of [
      listBoundaryOpsHandler(ctx),
      getBoundaryAuditStateHandler(ctx),
    ]) {
      await expect(
        handler({ auth: principal, params: { did: DID } }),
      ).rejects.toThrow(AuthRequiredError)
    }
    expect(boundaryAudit.list).not.toHaveBeenCalled()
    expect(boundaryAudit.checkpoint).not.toHaveBeenCalled()
  })

  it.each([undefined, 42, 'rei'])(
    'rejects invalid actor identifiers: %s',
    async (did) => {
      const { ctx } = fixture()
      await expect(
        listBoundaryOpsHandler(ctx)({ auth, params: { did } }),
      ).rejects.toMatchObject({
        errorMessage:
          typeof did === 'string'
            ? 'did must be a valid DID'
            : 'did is required',
      })
    },
  )

  it.each([
    [new BoundaryHistoryTruncatedError(), 'BoundaryHistoryTruncated'],
    [new RangeError('bad limit'), undefined],
  ])('maps expected errors to XRPC errors', async (error, code) => {
    const { ctx, boundaryAudit } = fixture()
    boundaryAudit.list.mockRejectedValue(error)
    await expect(
      listBoundaryOpsHandler(ctx)({ auth, params: { did: DID } }),
    ).rejects.toMatchObject({
      customErrorName: code,
      errorMessage: error?.message,
    })
  })

  it('propagates unexpected storage failure without a success response', async () => {
    const { ctx, boundaryAudit } = fixture()
    const error = new Error('storage failed')
    boundaryAudit.list.mockRejectedValue(error)
    await expect(
      listBoundaryOpsHandler(ctx)({ auth, params: { did: DID } }),
    ).rejects.toBe(error)
  })

  it('registers both queries with the admin verifier', () => {
    const { ctx } = fixture()
    const method = vi.fn()
    registerBoundaryAuditHandlers({ method } as never, ctx)
    expect(
      method.mock.calls.map(([nsid, config]) => [
        nsid,
        config.type,
        config.auth,
      ]),
    ).toEqual([
      ['zone.stratos.admin.listBoundaryOps', 'query', ctx.authVerifier.admin],
      [
        'zone.stratos.admin.getBoundaryAuditState',
        'query',
        ctx.authVerifier.admin,
      ],
    ])
  })
})
