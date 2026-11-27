import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import express from 'express'

import { createAppContext, type AppContext } from '../src/context.js'
import { registerEnrollmentHandlers } from '../src/features/index.js'
import {
  applyWritesBatch,
  createRecord,
  updateRecord,
} from '../src/api/records/index.js'
import { authorizeRecordBoundary } from '../src/api/records/validation.js'
import { cborToRecord, createMockBlobStore, createTestConfig } from './utils'

const SERVICE_DID = 'did:web:stratos.test'
const ENGINEERING = `${SERVICE_DID}/engineering`
const DESIGN = `${SERVICE_DID}/design`
const GENERAL = `${SERVICE_DID}/general`
const COLLECTION = 'zone.stratos.feed.post'
const PILOT = 'did:plc:shinji-ikari'
const ADMIN = 'did:plc:gendo-ikari'
const CACHE_LIFETIME_MS = 60_000

function post(text: string, boundary: string) {
  return {
    $type: COLLECTION,
    text,
    createdAt: '2026-01-01T00:00:00.000Z',
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: [{ value: boundary }],
    },
  }
}

function postRoute(
  app: express.Application,
  path: string,
  body: unknown,
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let statusCode = 200
    const req = {
      query: {},
      body,
      headers: {},
      method: 'POST',
      url: path,
      _body: true,
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
      if (err) return reject(err instanceof Error ? err : new Error('route'))
      resolve({ statusCode, body: null })
    })
  })
}

describe('Write authorization reads boundaries through a cache', () => {
  let dataDir: string
  let ctx: AppContext
  let getBoundariesFromStore: ReturnType<typeof vi.spyOn>

  async function enrollPilot(boundaries: string[]) {
    await ctx.enrollmentStore.enroll({
      did: PILOT,
      enrolledAt: '2026-01-01T00:00:00.000Z',
      boundaries,
      signingKeyDid: 'did:key:zEvaTestKey',
      active: true,
      isService: false,
      custody: 'stratos',
    })
    await ctx.actorStore.create(PILOT)
  }

  function authorize(boundary: string) {
    return authorizeRecordBoundary(
      ctx,
      PILOT,
      COLLECTION,
      post('Unit-01 sortie', boundary),
    )
  }

  function writePost(rkey: string, boundary: string) {
    return createRecord(
      ctx,
      {
        repo: PILOT,
        collection: COLLECTION,
        rkey,
        record: post('Unit-01 sortie', boundary),
      },
      PILOT,
    )
  }

  function callAdmin(name: string, body: unknown) {
    return postRoute(ctx.app, `/xrpc/zone.stratos.admin.${name}`, body)
  }

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-write-cache-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })
    const base = createTestConfig(dataDir)
    ctx = await createAppContext({
      cfg: {
        ...base,
        stratos: {
          ...base.stratos,
          serviceDid: SERVICE_DID,
          allowedDomains: [ENGINEERING, DESIGN, GENERAL],
          reservedDomain: GENERAL,
        },
      },
      blobstore: () => createMockBlobStore(),
      cborToRecord,
    })
    registerEnrollmentHandlers({ method: vi.fn() } as never, ctx)
    vi.spyOn(ctx.authVerifier, 'admin').mockResolvedValue({
      credentials: { type: 'admin', did: ADMIN },
    } as never)
    getBoundariesFromStore = vi.spyOn(ctx.enrollmentStore, 'getBoundaries')
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await ctx.destroy()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('has a write resolver that is separate from the live resolver', () => {
    expect(ctx.writeBoundaryResolver).toBeDefined()
    expect(ctx.writeBoundaryResolver).not.toBe(ctx.boundaryResolver)
  })

  it('fills the cache once for two writes and reads the store once under the lock for each', async () => {
    await enrollPilot([ENGINEERING])
    const getBoundariesLive = vi.spyOn(ctx.boundaryResolver, 'getBoundaries')
    getBoundariesFromStore.mockClear()

    await writePost('sortie-one', ENGINEERING)
    await writePost('sortie-two', ENGINEERING)

    expect(getBoundariesLive).toHaveBeenCalledTimes(2)
    expect(getBoundariesFromStore).toHaveBeenCalledTimes(3)
  })

  it('reads the store again once the cache lifetime has passed', async () => {
    await enrollPilot([ENGINEERING])
    vi.useFakeTimers({ toFake: ['Date'] })
    getBoundariesFromStore.mockClear()

    await authorize(ENGINEERING)
    vi.setSystemTime(Date.now() + CACHE_LIFETIME_MS - 1_000)
    await authorize(ENGINEERING)
    expect(getBoundariesFromStore).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 2_000)
    await authorize(ENGINEERING)
    expect(getBoundariesFromStore).toHaveBeenCalledTimes(2)
  })

  it('keeps reads through the live resolver uncached after a write fills the cache', async () => {
    await enrollPilot([ENGINEERING])
    await writePost('sortie-one', ENGINEERING)
    getBoundariesFromStore.mockClear()

    await ctx.boundaryResolver.getBoundaries(PILOT)
    await ctx.boundaryResolver.getBoundaries(PILOT)

    expect(getBoundariesFromStore).toHaveBeenCalledTimes(2)
  })

  it('rejects the next write at once after an admin removes the boundary', async () => {
    await enrollPilot([ENGINEERING, DESIGN])
    await writePost('sortie-one', DESIGN)

    const removal = await callAdmin('removeBoundary', {
      did: PILOT,
      boundary: DESIGN,
    })
    expect(removal.statusCode).toBe(200)

    await expect(writePost('sortie-two', DESIGN)).rejects.toMatchObject({
      error: 'ForbiddenBoundary',
    })
    await expect(writePost('sortie-three', ENGINEERING)).resolves.toBeDefined()
  })

  it('rejects the next write at once after an admin sets a smaller boundary list', async () => {
    await enrollPilot([ENGINEERING, DESIGN])
    await writePost('sortie-one', DESIGN)

    const replacement = await callAdmin('setBoundaries', {
      did: PILOT,
      boundaries: [ENGINEERING],
    })
    expect(replacement.statusCode).toBe(200)

    await expect(writePost('sortie-two', DESIGN)).rejects.toMatchObject({
      error: 'ForbiddenBoundary',
    })
  })

  it('does not cache a read that an invalidation overtook', async () => {
    await enrollPilot([ENGINEERING, DESIGN])
    const oldBoundaries = [ENGINEERING, DESIGN]
    let releaseOldRead: (boundaries: string[]) => void = () => undefined
    const oldRead = new Promise<string[]>((resolve) => {
      releaseOldRead = resolve
    })
    getBoundariesFromStore.mockImplementationOnce(() => oldRead)

    const inFlightAuthorization = authorize(DESIGN)
    await vi.waitFor(() => {
      expect(getBoundariesFromStore).toHaveBeenCalledTimes(1)
    })

    const removal = await callAdmin('removeBoundary', {
      did: PILOT,
      boundary: DESIGN,
    })
    expect(removal.statusCode).toBe(200)
    releaseOldRead(oldBoundaries)
    await inFlightAuthorization
    getBoundariesFromStore.mockClear()

    await expect(writePost('sortie-two', DESIGN)).rejects.toMatchObject({
      error: 'ForbiddenBoundary',
    })
    expect(getBoundariesFromStore).toHaveBeenCalledTimes(1)
  })

  it('stops authorizing the caller at once after unenrollment', async () => {
    await enrollPilot([ENGINEERING])
    await expect(authorize(ENGINEERING)).resolves.toBe(ENGINEERING)

    await ctx.enrollmentService.unenroll(PILOT)

    await expect(authorize(ENGINEERING)).rejects.toMatchObject({
      error: 'ForbiddenBoundary',
    })
  })

  it('rejects update and batch at once after an admin deactivates the member', async () => {
    await enrollPilot([ENGINEERING])
    await writePost('sortie-one', ENGINEERING)

    const deactivation = await callAdmin('setActive', {
      did: PILOT,
      active: false,
    })
    expect(deactivation.statusCode).toBe(200)

    await expect(authorize(ENGINEERING)).resolves.toBe(ENGINEERING)
    await expect(
      updateRecord(
        ctx,
        {
          repo: PILOT,
          collection: COLLECTION,
          rkey: 'sortie-one',
          record: post('Unit-01 sortie, revised', ENGINEERING),
        },
        PILOT,
      ),
    ).rejects.toMatchObject({ error: 'NotEnrolled' })
    await expect(
      applyWritesBatch(ctx, PILOT, [
        {
          action: 'create',
          collection: COLLECTION,
          rkey: 'sortie-two',
          record: post('Unit-01 second sortie', ENGINEERING),
        },
      ]),
    ).rejects.toMatchObject({ error: 'NotEnrolled' })
  })
})
