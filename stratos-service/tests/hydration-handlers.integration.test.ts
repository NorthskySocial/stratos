import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import {
  computeCid,
  encodeRecord,
  stratosLexicons,
} from '@northskysocial/stratos-core'
import { decode } from '@atcute/cbor'
import { Server as XrpcServer } from '@atproto/xrpc-server'
import express from 'express'
import axios from 'axios'
import http from 'http'

import { SqliteEnrollmentStore, StratosActorStore } from '../src/context.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db'
import {
  initHydration,
  registerHydrationHandlers,
} from '../src/features'
import { createMockBlobStore, createTestConfig } from './utils'

describe('Hydration Handlers', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let enrollmentStore: SqliteEnrollmentStore
  let db: ServiceDb
  let ctx: any
  let server: XrpcServer
  let app: express.Application
  let httpServer: http.Server
  let url: string

  const testDid = 'did:plc:shinji-ikari'
  const otherDid = 'did:plc:asuka-langley'
  const serviceDid = 'did:web:nerv.tokyo.jp'
  const collection = 'zone.stratos.feed.post'
  const engineeringBoundary = 'did:web:nerv.tokyo.jp/engineering'
  const pilotBoundary = 'did:web:nerv.tokyo.jp/pilot'

  beforeEach(async () => {
    dataDir = join(tmpdir(), `stratos-test-${randomBytes(8).toString('hex')}`)
    await mkdir(dataDir, { recursive: true })

    const cfg = createTestConfig(dataDir)
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)

    enrollmentStore = new SqliteEnrollmentStore(db)
    actorStore = new StratosActorStore({
      dataDir,
      blobstore: () => createMockBlobStore(),
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })

    const hydrationCtx = initHydration(actorStore, enrollmentStore, {
      getBlobMetadata: vi.fn(),
      putBlobMetadata: vi.fn(),
    } as any)

    ctx = {
      cfg: {
        ...cfg,
        stratos: {
          serviceDid: serviceDid,
          allowedDomains: ['nerv.tokyo.jp'],
          boundaries: {
            requireOne: true,
          },
        },
      },
      actorStore,
      enrollmentStore,
      serviceDid,
      hydrationService: hydrationCtx.hydrationService,
      syncService: hydrationCtx.syncService,
      boundaryResolver: {
        getBoundaries: vi.fn().mockImplementation(async (did: string) => {
          console.log(`[DEBUG_LOG] Resolving boundaries for: ${did}`)
          if (did === testDid) return [engineeringBoundary, pilotBoundary]
          if (did === otherDid) return [pilotBoundary]
          if (did === 'did:plc:authorized') return [engineeringBoundary]
          return []
        }),
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn((obj, msg) => {
          console.error(
            '[DEBUG_LOG] Request failed:',
            msg,
            JSON.stringify(obj, null, 2),
          )
          if (obj.err?.stack) console.error(obj.err.stack)
        }),
        warn: vi.fn(),
      },
      authVerifier: {
        standard: async (req: express.Request) => {
          const auth = req.headers.authorization
          console.log(`[DEBUG_LOG] Auth header in standard: ${auth}`)
          if (auth?.startsWith('Bearer did:')) {
            return { credentials: { did: auth.slice(7), type: 'dpop' } }
          }
          return { credentials: {} }
        },
        optionalStandard: async (req: express.Request) => {
          const auth = req.headers.authorization
          console.log(`[DEBUG_LOG] Auth header in optionalStandard: ${auth}`)
          if (auth?.startsWith('Bearer did:')) {
            return { credentials: { did: auth.slice(7), type: 'dpop' } }
          }
          return { credentials: {} }
        },
      },
      stubQueue: {
        enqueueWrite: vi.fn(),
        enqueueDelete: vi.fn(),
      },
      writeRateLimiter: {
        assertWriteAllowed: vi.fn(),
      },
    }

    server = new XrpcServer(stratosLexicons)
    app = express()

    app.use(async (req, res, next) => {
      const auth = req.headers.authorization
      if (auth?.startsWith('Bearer did:')) {
        const did = auth.slice(7)
        console.log(`[DEBUG_LOG] Setting req.auth for DID: ${did}`)
        // @ts-ignore
        req['auth'] = { credentials: { did, type: 'dpop' } }
      }
      next()
    })

    registerHydrationHandlers(server, ctx)
    app.use(server.router)

    httpServer = app.listen(0)
    const port = (httpServer.address() as any).port
    url = `http://localhost:${port}`

    // Setup actor and a record
    await actorStore.create(testDid)
    await actorStore.transact(testDid, async (store) => {
      const record1 = {
        $type: collection,
        text: 'Unit-01: Shinji Ikari',
        createdAt: new Date().toISOString(),
        boundary: {
          $type: 'zone.stratos.boundary.defs#Domains',
          values: [{ value: engineeringBoundary }],
        },
      }
      const cid1 = await computeCid(record1)
      await store.record.putRecord({
        uri: `at://${testDid}/${collection}/post1`,
        cid: cid1,
        value: record1,
        content: encodeRecord(record1),
      })

      const record2 = {
        $type: collection,
        text: 'Unit-00: Rei Ayanami',
        createdAt: new Date().toISOString(),
        boundary: {
          $type: 'zone.stratos.boundary.defs#Domains',
          values: [{ value: pilotBoundary }],
        },
      }
      const cid2 = await computeCid(record2)
      await store.record.putRecord({
        uri: `at://${testDid}/${collection}/post2`,
        cid: cid2,
        value: record2,
        content: encodeRecord(record2),
      })
    })
  })

  afterEach(async () => {
    await new Promise((resolve) => httpServer.close(resolve))
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  describe('hydrateRecord', () => {
    it('should successfully hydrate a record for authorized viewer', async () => {
      const res = await axios.get(
        `${url}/xrpc/zone.stratos.repo.hydrateRecord`,
        {
          params: { uri: `at://${testDid}/${collection}/post1` },
          headers: { Authorization: 'Bearer did:plc:authorized' },
        },
      )

      expect(res.status).toBe(200)
      expect(res.data.uri).toBe(`at://${testDid}/${collection}/post1`)
      expect(res.data.value).toMatchObject({ text: 'Unit-01: Shinji Ikari' })
    })

    it('should allow a viewer with a different matching boundary', async () => {
      const res = await axios.get(
        `${url}/xrpc/zone.stratos.repo.hydrateRecord`,
        {
          params: { uri: `at://${testDid}/${collection}/post2` },
          headers: { Authorization: `Bearer ${otherDid}` },
        },
      )

      expect(res.status).toBe(200)
      expect(res.data.uri).toBe(`at://${testDid}/${collection}/post2`)
      expect(res.data.value).toMatchObject({ text: 'Unit-00: Rei Ayanami' })
    })

    it('should throw RecordBlocked for unauthorized viewer (no matching boundaries)', async () => {
      const promise = axios.get(`${url}/xrpc/zone.stratos.repo.hydrateRecord`, {
        params: { uri: `at://${testDid}/${collection}/post1` },
        headers: { Authorization: `Bearer ${otherDid}` },
      })

      await expect(promise).rejects.toMatchObject({
        response: {
          status: 400,
          data: { error: 'RecordBlocked' },
        },
      })
    })

    it('should throw RecordNotFound for missing record', async () => {
      const promise = axios.get(`${url}/xrpc/zone.stratos.repo.hydrateRecord`, {
        params: { uri: `at://${testDid}/${collection}/missing` },
      })

      await expect(promise).rejects.toMatchObject({
        response: {
          status: 400,
          data: { error: 'RecordNotFound' },
        },
      })
    })
  })

  describe('hydrateRecords', () => {
    it('should hydrate a batch of records', async () => {
      const res = await axios.post(
        `${url}/xrpc/zone.stratos.repo.hydrateRecords`,
        {
          uris: [
            `at://${testDid}/${collection}/post1`,
            `at://${testDid}/${collection}/missing`,
          ],
        },
        {
          headers: { Authorization: 'Bearer did:plc:authorized' },
        },
      )

      expect(res.status).toBe(200)
      expect(res.data.records).toHaveLength(1)
      expect(res.data.records[0].uri).toBe(
        `at://${testDid}/${collection}/post1`,
      )
      expect(res.data.notFound).toContain(
        `at://${testDid}/${collection}/missing`,
      )
    })

    it('should report blocked records in batch', async () => {
      const res = await axios.post(
        `${url}/xrpc/zone.stratos.repo.hydrateRecords`,
        {
          uris: [`at://${testDid}/${collection}/post1`],
        },
        {
          headers: { Authorization: 'Bearer did:plc:unauthorized' },
        },
      )

      expect(res.status).toBe(200)
      expect(res.data.records).toHaveLength(0)
      expect(res.data.blocked).toContain(`at://${testDid}/${collection}/post1`)
    })

    it('should enforce 100 URI limit', async () => {
      const uris = Array(101).fill(`at://${testDid}/${collection}/post1`)
      const promise = axios.post(
        `${url}/xrpc/zone.stratos.repo.hydrateRecords`,
        { uris },
      )

      await expect(promise).rejects.toMatchObject({
        response: {
          status: 400,
          data: { error: 'InvalidRequest' },
        },
      })
    })

    it('should return empty results for empty input', async () => {
      const res = await axios.post(
        `${url}/xrpc/zone.stratos.repo.hydrateRecords`,
        { uris: [] },
      )

      expect(res.status).toBe(200)
      expect(res.data.records).toHaveLength(0)
      expect(res.data.notFound).toHaveLength(0)
    })
  })
})
