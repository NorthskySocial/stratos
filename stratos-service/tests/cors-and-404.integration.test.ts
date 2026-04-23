import { ENROLLMENT_MODE } from '@northskysocial/stratos-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import http from 'http'
import axios from 'axios'
import { decode } from '@atcute/cbor'

import { StratosServer } from '../src'
import { createMockBlobStore, createTestConfig } from './utils'

describe('CORS and 404 Verification', () => {
  let dataDir: string
  let httpServer: http.Server
  let url: string

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-cors-test-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })

    const cfg = createTestConfig(dataDir)
    // Use CLOSED mode to ensure unknown DIDs are not auto-enrolled
    cfg.enrollment.mode = ENROLLMENT_MODE.CLOSED
    cfg.stratos.allowedDomains = ['example.com']

    const server = await StratosServer.create(
      cfg,
      () => createMockBlobStore(),
      (content) => decode(content) as Record<string, unknown>,
    )

    await server.start()
    const port = cfg.service.port
    url = `http://localhost:${port}`
    // @ts-ignore - accessing private property for testing
    httpServer = server.server
  })

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
      })
    }
    await rm(dataDir, { recursive: true, force: true })
  })

  it('should have CORS headers on zone.stratos.server.listDomains', async () => {
    const res = await axios.get(`${url}/xrpc/zone.stratos.server.listDomains`, {
      headers: { Origin: 'http://localhost:5173' },
    })
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    )
    expect(res.data.domains).toContain('example.com')
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
