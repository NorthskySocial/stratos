import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { stratosLexicons } from '@northskysocial/stratos-core'
import { decode } from '@atcute/cbor'
import { Server as XrpcServer } from '@atproto/xrpc-server'
import express from 'express'
import axios from 'axios'
import http from 'http'
import { CID } from 'multiformats/cid'

import { StratosActorStore } from '../../src/context.js'
import { SqliteStorageFactory } from '../../src/infra/storage'
import { createServiceDb, migrateServiceDb } from '../../src/db'
import { registerHandlers } from '../../src/api'
import { createMockBlobStore, createTestConfig } from '../utils'
import { BloomManager, SyncServiceImpl } from '../../src/features'

describe('zone.stratos.sync.getBlob integration', () => {
  let dataDir: string
  let storageFactory: SqliteStorageFactory
  let httpServer: http.Server
  let url: string
  let bloomManager: BloomManager
  const testDid = 'did:plc:test-actor'
  const otherDid = 'did:plc:other-actor'
  const boundary = 'engineering'
  let ctx: any

  beforeEach(async () => {
    dataDir = join(tmpdir(), `stratos-test-${randomBytes(8).toString('hex')}`)
    await mkdir(dataDir, { recursive: true })

    const db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)

    const mockBlobStore = createMockBlobStore()
    const blobstore = () => mockBlobStore
    const config = createTestConfig(dataDir)

    storageFactory = new SqliteStorageFactory({
      dataDir,
      serviceDb: db,
      blobContentStoreCreator: blobstore,
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })

    const actorStore = new StratosActorStore({
      dataDir,
      blobstore,
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })

    bloomManager = new BloomManager()

    ctx = {
      actorStore,
      storageFactory,
      boundaryResolver: {
        getBoundaries: vi.fn(async (did: string) => {
          if (did === testDid) return [boundary]
          return []
        }),
      },
      authVerifier: {
        standard: async (req: any) => {
          const auth = req.headers.authorization
          if (!auth) return null
          const did = auth.replace('Bearer ', '')
          return { credentials: { did } }
        },
        optionalStandard: async (req: any) => {
          const auth = req.headers.authorization
          if (!auth) return null
          const did = auth.replace('Bearer ', '')
          return { credentials: { did } }
        },
      },
      logger: {
        debug: console.debug,
        info: console.info,
        warn: console.warn,
        error: console.error,
      },
      bloomManager,
      syncService: new SyncServiceImpl(actorStore, bloomManager, {
        getBoundaries: async (did: string) => {
          if (did === testDid) return [boundary]
          if (did === otherDid) {
            // The test mocks this later, so we need to call the mock
            return ctx.boundaryResolver.getBoundaries(did)
          }
          return []
        },
      } as any),
    }

    const app = express()
    app.use(express.json())

    ctx = {
      ...ctx,
      app,
    }

    // Mock middleware to populate req.auth
    app.use(async (req: any, res, next) => {
      const auth = req.headers.authorization
      if (auth) {
        const did = auth.replace('Bearer ', '')
        req.auth = { credentials: { did } }
      }
      next()
    })

    const server = new XrpcServer()
    server.addLexicons(stratosLexicons)
    // Register standard handlers, which will in turn register sync handlers
    registerHandlers(server, ctx)
    app.use(server.router)

    // Log errors from the router
    app.use((err: any, req: any, res: any, next: any) => {
      // console.error('[DEBUG_LOG] Express error handler:', err)
      const status = err.status || 500
      res.status(status).json({
        error: err.error || 'InternalServerError',
        message: err.message,
      })
    })

    httpServer = app.listen(0)
    await new Promise((resolve) => httpServer.on('listening', resolve))
    const address = httpServer.address() as any
    url = `http://localhost:${address.port}`

    // Setup actor and a record with a blob
    await storageFactory.createActor(testDid)

    const blobContent = new TextEncoder().encode('Unit-01 Status: Active')
    const blobCid = CID.parse(
      'bafkreidv6s66p3scy27l6yq6x6vj6h7v7uv7uv7uv7uv7uv7uv7uv7uv7u',
    )

    await storageFactory.transactActor(testDid, async (stores) => {
      // 1. Put the blob
      await stores.blobContent.putPermanent(blobCid, blobContent)

      // Track the blob in the database too
      await (stores.blobMetadata as any).trackBlob({
        cid: blobCid,
        mimeType: 'text/plain',
        size: blobContent.length,
      })

      // 2. Associate with boundary
      await stores.blobMetadata.associateBlobWithBoundary(blobCid, boundary)

      // 3. Update bloom manager
      await bloomManager.updateBloom(blobCid, [boundary])
    })
  })

  afterEach(async () => {
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(resolve))
    }
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('denies a viewer without matching boundaries (fast rejection)', async () => {
    const blobCid =
      'bafkreidv6s66p3scy27l6yq6x6vj6h7v7uv7uv7uv7uv7uv7uv7uv7uv7u'
    try {
      await axios.get(`${url}/xrpc/zone.stratos.sync.getBlob`, {
        params: { did: testDid, cid: blobCid },
        headers: { Authorization: `Bearer ${otherDid}` },
      })
      throw new Error('Should have failed')
    } catch (err: any) {
      expect(err.response.status).toBe(400)
      expect(err.response.data.error).toBe('BlobBlocked')
      expect(err.response.data.message).toContain('fast rejection')
    }
  })

  it('denies a viewer when bloom filter has a false positive but DB check fails', async () => {
    const blobCid = CID.parse(
      'bafkreidv6s66p3scy27l6yq6x6vj6h7v7uv7uv7uv7uv7uv7uv7uv7uv7u',
    )
    const sneakyBoundary = 'sneaky-boundary'

    // Manually add a boundary to bloom filter that the user has,
    // even though the blob doesn't actually have it in the DB.
    await bloomManager.updateBloom(blobCid, [sneakyBoundary])

    // Mock boundary resolver to give the viewer this sneaky boundary
    ctx.boundaryResolver.getBoundaries = vi.fn(async (did: string) => {
      if (did === otherDid) return [sneakyBoundary]
      return []
    })

    try {
      await axios.get(`${url}/xrpc/zone.stratos.sync.getBlob`, {
        params: { did: testDid, cid: blobCid.toString() },
        headers: { Authorization: `Bearer ${otherDid}` },
      })
      throw new Error('Should have failed')
    } catch (err: any) {
      expect(err.response.status).toBe(400)
      expect(err.response.data.error).toBe('BlobBlocked')
      // Should NOT contain 'fast rejection' because bloom filter passed
      expect(err.response.data.message).not.toContain('fast rejection')
      expect(err.response.data.message).toContain(
        'Access denied to blob due to boundary restrictions',
      )
    }
  })

  it('denies an unauthenticated viewer for private blobs', async () => {
    const blobCid =
      'bafkreidv6s66p3scy27l6yq6x6vj6h7v7uv7uv7uv7uv7uv7uv7uv7uv7u'
    try {
      await axios.get(`${url}/xrpc/zone.stratos.sync.getBlob`, {
        params: { did: testDid, cid: blobCid },
      })
      throw new Error('Should have failed')
    } catch (err: any) {
      expect(err.response.status).toBe(401)
      expect(err.response.data.error).toBe('AuthenticationRequired')
    }
  })

  it('allows the owner to bypass boundary checks regardless of bloom filter', async () => {
    const blobCid =
      'bafkreidv6s66p3scy27l6yq6x6vj6h7v7uv7uv7uv7uv7uv7uv7uv7uv7u'

    // Clear bloom for this CID to ensure it's not helping
    await bloomManager.clearBloom(CID.parse(blobCid))

    const res = await axios.get(`${url}/xrpc/zone.stratos.sync.getBlob`, {
      params: { did: testDid, cid: blobCid },
      headers: { Authorization: `Bearer ${testDid}` },
      responseType: 'arraybuffer',
    })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    // When using axios with responseType: 'arraybuffer', res.data IS the buffer
    const content = new TextDecoder().decode(res.data)
    expect(content).toBe('Unit-01 Status: Active')
  })
})
