import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'

import { requestInstrumentation } from '../src/index.js'
import { serviceMetrics } from '../src/observability/metrics.js'

describe('service request instrumentation', () => {
  it.each([
    ['OPTIONS', '/xrpc/zone.stratos.feedgen.getFeed', false],
    ['GET', '/xrpc/zone.stratos.enrollment.status', true],
    ['GET', '/oauth/boundaries', false],
  ])(
    'records %s %s without treating preflight as authentication',
    (method, path, authenticated) => {
      const complete = vi.fn()
      const abort = vi.fn()
      const begin = vi
        .spyOn(serviceMetrics, 'beginHttpRequest')
        .mockReturnValue({ complete, abort })
      const recordAuth = vi.spyOn(serviceMetrics, 'recordAuth')
      const req = { method, path } as Request
      const res = Object.assign(new EventEmitter(), {
        statusCode: 204,
      }) as Response
      try {
        requestInstrumentation()(req, res, vi.fn())
        res.emit('finish')
        res.emit('close')
        expect(complete).toHaveBeenCalledExactlyOnceWith({
          method,
          route: path.includes('feedgen') ? '/xrpc/:nsid' : path,
          status: 204,
          durationSeconds: expect.any(Number),
        })
        expect(abort).not.toHaveBeenCalled()
        expect(recordAuth.mock.calls).toEqual(authenticated ? [['ok']] : [])
      } finally {
        begin.mockRestore()
        recordAuth.mockRestore()
      }
    },
  )

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
