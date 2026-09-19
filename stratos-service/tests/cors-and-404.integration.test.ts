import { ENROLLMENT_MODE } from '@northskysocial/stratos-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import http from 'http'
import axios from 'axios'
import { decode } from '@atcute/cbor'
import { gzipSync } from 'node:zlib'

import { StratosServer } from '../src'
import { createMockBlobStore, createTestConfig } from './utils'
import { serviceMetrics } from '../src/observability/metrics.js'

describe('CORS and 404 Verification', () => {
  let dataDir: string
  let httpServer: http.Server
  let url: string
  let service: StratosServer

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-cors-test-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })

    const cfg = createTestConfig(dataDir)
    // Use CLOSED mode to ensure unknown DIDs are not auto-enrolled
    cfg.enrollment.mode = ENROLLMENT_MODE.CLOSED
    cfg.stratos.allowedDomains = [
      'did:web:nerv.tokyo.jp/example.com',
      cfg.stratos.reservedDomain,
    ]
    cfg.allowedRedirectOrigins = ['http://localhost:5173']

    const server = await StratosServer.create(
      cfg,
      () => createMockBlobStore(),
      (content) => decode(content) as Record<string, unknown>,
    )

    service = server
    await server.start()
    // @ts-ignore - accessing private property for testing
    httpServer = server.server
    const port = (httpServer.address() as { port: number }).port
    url = `http://localhost:${port}`
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await service?.stop()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('rejects compressed JSON by its decoded size', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const compressed = gzipSync(JSON.stringify({ name: 'Rei'.repeat(40_000) }))
    expect(compressed.byteLength).toBeLessThan(100 * 1024)
    const response = await fetch(`${url}/missing`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      body: compressed,
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: 'PayloadTooLarge',
      message: 'Request body is too large',
    })
    expect(errorLog).not.toHaveBeenCalled()
    errorLog.mockRestore()
  })

  it('does not report other parser failures as oversized bodies', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await fetch(`${url}/missing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{Rei',
    })
    expect(response.status).not.toBe(413)
    expect((await response.json()).error).not.toBe('PayloadTooLarge')
    errorLog.mockRestore()
  })

  it('should have CORS headers on zone.stratos.server.listDomains', async () => {
    const res = await axios.get(`${url}/xrpc/zone.stratos.server.listDomains`, {
      headers: { Origin: 'http://localhost:5173' },
    })
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    )
    expect(res.data.domains).toContain('did:web:nerv.tokyo.jp/example.com')
  })

  it('should have CORS headers on zone.stratos.enrollment.status', async () => {
    const res = await axios.get(
      `${url}/xrpc/zone.stratos.enrollment.status?did=did:plc:test`,
      {
        headers: { Origin: 'http://localhost:5173' },
      },
    )
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    )
    expect(res.data.enrolled).toBe(false)
  })

  it('should handle preflight OPTIONS request for com.atproto.repo.createRecord', async () => {
    const complete = vi.fn()
    const begin = vi
      .spyOn(serviceMetrics, 'beginHttpRequest')
      .mockReturnValue({ complete, abort: vi.fn() })
    try {
      const res = await axios.options(
        `${url}/xrpc/com.atproto.repo.createRecord`,
        {
          headers: {
            Origin: 'http://localhost:5173',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'Content-Type,Authorization',
          },
        },
      )
      expect(res.status).toBe(204)
      expect(res.headers['access-control-allow-origin']).toBe(
        'http://localhost:5173',
      )
      expect(res.headers['access-control-allow-methods']).toContain('POST')
      expect(res.headers['timing-allow-origin']).toBe('http://localhost:5173')
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'OPTIONS',
          route: '/xrpc/com.atproto.repo.createRecord',
          status: 204,
        }),
      )
    } finally {
      begin.mockRestore()
    }
  })

  it('should not return 404 for standard XRPC methods', async () => {
    // repo.listRecords usually requires some parameters, but should at least not 404 (maybe 400 if params missing)
    try {
      await axios.get(`${url}/xrpc/com.atproto.repo.listRecords`, {
        headers: { Origin: 'http://localhost:5173' },
      })
    } catch (err: any) {
      expect(err.response.status).not.toBe(404)
    }
  })
})
