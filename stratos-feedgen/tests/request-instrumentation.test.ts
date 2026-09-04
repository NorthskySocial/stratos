import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'

import type { FeedgenMetrics } from '../src/metrics.js'
import { requestInstrumentation } from '../src/server.js'

describe('feedgen request instrumentation', () => {
  it('settles an aborted request once without recording a response', () => {
    const complete = vi.fn()
    const abort = vi.fn()
    const metrics = {
      beginHttpRequest: vi.fn(() => ({ complete, abort })),
    } as unknown as FeedgenMetrics
    const req = { method: 'GET', path: '/health' } as Request
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
    }) as Response
    const next = vi.fn()

    requestInstrumentation({ metrics })(req, res, next)
    res.emit('close')
    res.emit('finish')

    expect(next).toHaveBeenCalledOnce()
    expect(complete).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledOnce()
  })
})
