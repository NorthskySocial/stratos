import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AppContext } from '../src'
import type { EnrollmentEventEmitter } from '../src/context-types.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from '../src/db/index.js'
import { SqliteLabelStore } from '../src/features/moderation/index.js'
import type { EnrollmentStore } from '../src/oauth'
import { registerEnrollmentHandlers } from '../src/features'
import { RepoWriteLocks } from '../src/shared/repo-write-lock.js'
import { SqliteEnrollmentStore } from '../src/storage/sqlite/enrollment-store.js'

interface MockResponse {
  statusCode: number
  body: unknown
}

function invokePostRoute(
  app: express.Application,
  path: string,
  body: unknown,
): Promise<MockResponse> {
  return new Promise((resolve, reject) => {
    let statusCode = 200
    const req = {
      query: {},
      body,
      headers: {},
      method: 'POST',
      url: path,
      _body: true, // Signal to express.json that the body is already parsed
    } as unknown as express.Request
    const res = {
      status(code: number) {
        statusCode = code
        return res
      },
      json(responseBody: unknown) {
        resolve({ statusCode, body: responseBody })
        return res
      },
      setHeader() {
        return res
      },
    } as unknown as express.Response

    app(req, res, (err?: unknown) => {
      if (err) {
        return reject(
          err instanceof Error
            ? err
            : new Error(`express next() called with: ${inspect(err)}`),
        )
      }
      resolve({ statusCode, body: null })
    })
  })
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function createCtx(opts: {
  seed?: { active: boolean; operatorHold: boolean } | null
  adminAuthFails?: boolean
}): Promise<{ app: express.Application; enrollmentStore: EnrollmentStore }> {
  const tmp = mkdtempSync(join(tmpdir(), 'stratos-set-active-'))
  const dbPath = join(tmp, 'service.sqlite')
  const db: ServiceDb = createServiceDb(dbPath)
  await migrateServiceDb(db)
  cleanups.push(async () => {
    await closeServiceDb(db)
    rmSync(tmp, { recursive: true, force: true })
  })
  const enrollmentStore = new SqliteEnrollmentStore(db)
  const seed =
    opts.seed === undefined ? { active: true, operatorHold: false } : opts.seed
  if (seed) {
    await enrollmentStore.enroll({
      did: 'did:plc:usagi',
      enrolledAt: '2026-01-01T00:00:00.000Z',
      signingKeyDid: 'did:key:zSailorMoon',
      active: seed.active,
      operatorHold: seed.operatorHold,
    })
  }

  const app = express()
  const enrollmentEvents: EnrollmentEventEmitter = new EventEmitter()

  const ctx = {
    app,
    enrollmentStore,
    enrollmentEvents,
    labelStore: new SqliteLabelStore(db, dbPath),
    repoWriteLocks: new RepoWriteLocks(),
    enrollmentService: {
      isEnrolled: (did: string) => enrollmentStore.isEnrolled(did),
      getEnrollment: vi.fn(),
    },
    boundaryResolver: { getBoundaries: vi.fn(async () => []) },
    authVerifier: {
      admin: opts.adminAuthFails
        ? vi.fn(async () => {
            throw new Error('Unauthorized')
          })
        : vi.fn(async () => ({
            credentials: { type: 'admin', did: 'did:plc:haruki' },
          })),
      optionalStandard: vi.fn(async () => ({ credentials: { did: null } })),
    },
    serviceDid: 'did:web:nerv.tokyo.jp',
    cfg: {
      service: { publicUrl: 'https://stratos.example.com' },
      stratos: {
        serviceDid: 'did:web:nerv.tokyo.jp',
        allowedDomains: ['did:web:nerv.tokyo.jp/general'],
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as AppContext

  registerEnrollmentHandlers({ method: vi.fn() } as never, ctx)
  return { app, enrollmentStore }
}

const ROUTE = '/xrpc/zone.stratos.admin.setActive'

const USAGI = 'did:plc:usagi'

async function storedState(store: EnrollmentStore, did: string) {
  const row = await store.getEnrollment(did)
  return row && { active: row.active, operatorHold: row.operatorHold }
}

describe('POST /xrpc/zone.stratos.admin.setActive', () => {
  it('rejects unauthenticated callers', async () => {
    const { app, enrollmentStore } = await createCtx({ adminAuthFails: true })
    const before = await enrollmentStore.getEnrollment(USAGI)

    const res = await invokePostRoute(app, ROUTE, {
      did: 'did:plc:usagi',
      active: false,
    })

    expect(res.statusCode).toBe(401)
    expect(await enrollmentStore.getEnrollment(USAGI)).toEqual(before)
  })

  it('deactivates an active member', async () => {
    const { app, enrollmentStore } = await createCtx({})

    const res = await invokePostRoute(app, ROUTE, {
      did: 'did:plc:usagi',
      active: false,
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ did: 'did:plc:usagi', active: false })
    expect(await storedState(enrollmentStore, USAGI)).toEqual({
      active: false,
      operatorHold: true,
    })
  })

  it('reactivates a deactivated member', async () => {
    const { app, enrollmentStore } = await createCtx({
      seed: { active: false, operatorHold: true },
    })

    const res = await invokePostRoute(app, ROUTE, {
      did: 'did:plc:usagi',
      active: true,
    })

    expect(res.statusCode).toBe(200)
    expect(await storedState(enrollmentStore, USAGI)).toEqual({
      active: true,
      operatorHold: false,
    })
  })

  it('is a no-op when the member is already in the requested state', async () => {
    const { app, enrollmentStore } = await createCtx({})
    const before = await enrollmentStore.getEnrollment(USAGI)

    const res = await invokePostRoute(app, ROUTE, {
      did: 'did:plc:usagi',
      active: true,
    })

    expect(res.statusCode).toBe(200)
    expect(await enrollmentStore.getEnrollment(USAGI)).toEqual(before)
  })

  it('returns 404 for a DID that is not enrolled', async () => {
    const { app, enrollmentStore } = await createCtx({ seed: null })

    const res = await invokePostRoute(app, ROUTE, {
      did: 'did:plc:nobody',
      active: false,
    })

    expect(res.statusCode).toBe(404)
    expect(await enrollmentStore.getEnrollment('did:plc:nobody')).toBeNull()
  })

  it.each([
    [{ did: 'did:plc:usagi' }],
    [{ did: 'did:plc:usagi', active: 'false' }],
    [{ active: false }],
    [{ did: 42, active: false }],
    [{ did: 'not-a-did', active: false }],
    [{ did: { did: 'did:plc:usagi' }, active: false }],
  ])('rejects a malformed body (%o)', async (body) => {
    const { app, enrollmentStore } = await createCtx({})
    const before = await enrollmentStore.getEnrollment(USAGI)

    const res = await invokePostRoute(app, ROUTE, body)

    expect(res.statusCode).toBe(400)
    expect(await enrollmentStore.getEnrollment(USAGI)).toEqual(before)
  })

  it('reports a store failure as an internal error', async () => {
    const { app, enrollmentStore } = await createCtx({})
    vi.spyOn(enrollmentStore, 'updateEnrollment').mockRejectedValue(
      new Error('database is on fire'),
    )

    const res = await invokePostRoute(app, ROUTE, {
      did: 'did:plc:usagi',
      active: false,
    })

    expect(res.statusCode).toBe(500)
    expect((res.body as { error: string }).error).toBe('InternalError')
  })
})
