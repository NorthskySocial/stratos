import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { browserTiming } from '../src/observability/browser-timing.js'

describe('browser resource timing access', () => {
  const clubhouse = 'https://bebop.example'

  it.each([clubhouse, 'https://nerv.example'])(
    'exposes timings to the configured client %s',
    (origin) => {
      const setHeader = vi.fn()
      const vary = vi.fn()
      const next = vi.fn()
      browserTiming([clubhouse, 'https://nerv.example'])(
        { headers: { origin } } as Request,
        { setHeader, vary } as unknown as Response,
        next,
      )
      expect(setHeader).toHaveBeenCalledExactlyOnceWith(
        'Timing-Allow-Origin',
        origin,
      )
      expect(vary).toHaveBeenCalledExactlyOnceWith('Origin')
      expect(next).toHaveBeenCalledOnce()
    },
  )

  it.each([
    undefined,
    'null',
    'https://bebop.example.attacker.example',
    'https://seele.example',
  ])('keeps timing details private for origin %s', (origin) => {
    const setHeader = vi.fn()
    const vary = vi.fn()
    const next = vi.fn()
    browserTiming([clubhouse])(
      { headers: { origin } } as Request,
      { setHeader, vary } as unknown as Response,
      next,
    )
    expect(setHeader).not.toHaveBeenCalled()
    expect(vary).toHaveBeenCalledExactlyOnceWith('Origin')
    expect(next).toHaveBeenCalledOnce()
  })
})
