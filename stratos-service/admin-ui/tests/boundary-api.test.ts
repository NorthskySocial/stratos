import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBoundary,
  deactivateBoundary,
  listBoundaries,
  reactivateBoundary,
  updateBoundary,
} from '../src/lib/api/boundary-catalog'
import {
  ApiError,
  onUnauthorized,
  request,
  whoami,
} from '../src/lib/api/client'
import { boundarySettings, newBoundaryDraft } from '../src/lib/boundary-form'

const settings = boundarySettings({
  ...newBoundaryDraft(),
  displayName: 'Bebop',
})
afterEach(() => {
  vi.unstubAllGlobals()
  onUnauthorized(() => {})
})

describe('boundary catalog XRPC transport', () => {
  it('lists the full catalog with the existing admin session cookie', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ boundaries: [] })))
    vi.stubGlobal('fetch', fetcher)
    expect(await listBoundaries()).toEqual({ boundaries: [] })
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      '/xrpc/zone.stratos.admin.listBoundaries',
      { credentials: 'include' },
    )
  })
  it.each([
    [
      'createBoundary',
      () => createBoundary('bebop', settings),
      { name: 'bebop', settings },
    ],
    [
      'updateBoundary',
      () => updateBoundary('did:web:nerv.test/bebop', 7, settings),
      { boundary: 'did:web:nerv.test/bebop', revision: 7, settings },
    ],
    [
      'deactivateBoundary',
      () => deactivateBoundary('did:web:nerv.test/bebop', 8),
      { boundary: 'did:web:nerv.test/bebop', revision: 8 },
    ],
    [
      'reactivateBoundary',
      () => reactivateBoundary('did:web:nerv.test/bebop', 9),
      { boundary: 'did:web:nerv.test/bebop', revision: 9 },
    ],
  ])('sends %s as a typed XRPC JSON procedure', async (method, call, body) => {
    const result = { boundary: { displayName: 'Bebop' } }
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(result)))
    vi.stubGlobal('fetch', fetcher)
    expect(await call()).toEqual(result)
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `/xrpc/zone.stratos.admin.${method}`,
      {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
  })
})

describe('admin session error recovery', () => {
  it('retains the conflict code separately from the human-readable message', async () => {
    const unauthorized = vi.fn()
    onUnauthorized(unauthorized)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'BoundaryConflict',
            message: 'The boundary changed.',
          }),
          { status: 400 },
        ),
      ),
    )
    await expect(updateBoundary('bebop', 1, settings)).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      code: 'BoundaryConflict',
      message: 'The boundary changed.',
    })
    expect(unauthorized).not.toHaveBeenCalled()
  })
  it.each([401, 403])(
    'retains %s authentication rejection behavior',
    async (status) => {
      const unauthorized = vi.fn()
      onUnauthorized(unauthorized)
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              error: 'AuthRequired',
              message: 'Sign in again',
            }),
            { status },
          ),
        ),
      )
      await expect(listBoundaries()).rejects.toMatchObject({
        status,
        message: 'Sign in again',
        code: 'AuthRequired',
      })
      expect(unauthorized).toHaveBeenCalledOnce()
    },
  )
  it('can still probe a session without notifying the signed-out handler', async () => {
    const unauthorized = vi.fn()
    onUnauthorized(unauthorized)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('{}', { status: 401, statusText: 'Unauthorized' }),
        ),
    )
    await expect(whoami()).rejects.toMatchObject({
      message: 'Unauthorized',
      code: undefined,
    })
    expect(unauthorized).not.toHaveBeenCalled()
  })
})

describe('admin request error fallbacks', () => {
  it.each([
    [JSON.stringify({ error: 'BoundaryUnavailable' }), 'BoundaryUnavailable'],
    [
      JSON.stringify({ message: '', error: 'BoundaryUnavailable' }),
      'BoundaryUnavailable',
    ],
    [JSON.stringify({ message: '', error: '' }), 'Bad Request'],
    ['{}', 'Bad Request'],
    ['not json', 'Bad Request'],
  ])('preserves useful error fallback for %s', async (body, message) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(body, { status: 400, statusText: 'Bad Request' }),
        ),
    )
    await expect(listBoundaries()).rejects.toMatchObject({
      message,
      status: 400,
      name: 'ApiError',
    })
  })
  it('supports callers without an unauthorized handler and preserves network errors', async () => {
    vi.resetModules()
    const fresh = await import('../src/lib/api/client')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('{}', { status: 403 }))
        .mockRejectedValueOnce(new Error('Offline')),
    )
    await expect(fresh.request('/private')).rejects.toMatchObject({
      status: 403,
    })
    await expect(request('/private')).rejects.toThrow('Offline')
    expect(new ApiError(400, 'Invalid')).toBeInstanceOf(Error)
  })
})
