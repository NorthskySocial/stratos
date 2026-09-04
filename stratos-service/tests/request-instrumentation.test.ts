import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'

import { requestInstrumentation } from '../src/index.js'
import { serviceMetrics } from '../src/observability/metrics.js'

describe('service request instrumentation', () => {
  it('settles an aborted request once without recording a response', () => {
    const complete = vi.fn()
    const abort = vi.fn()
    const beginHttpRequest = vi
      .spyOn(serviceMetrics, 'beginHttpRequest')
      .mockReturnValue({ complete, abort })
    const req = {
      method: 'GET',
      path: '/health',
      traceId: 'shinji',
    } as Request
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
    }) as Response
    const next = vi.fn()

    try {
      requestInstrumentation()(req, res, next)
      res.emit('close')
      res.emit('finish')

      expect(next).toHaveBeenCalledOnce()
      expect(complete).not.toHaveBeenCalled()
      expect(abort).toHaveBeenCalledOnce()
    } finally {
      beginHttpRequest.mockRestore()
    }
  })
})
