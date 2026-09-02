import { EventEmitter } from 'node:events'
import { inspect } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AppContext } from '../src'
import type { EnrollmentEventEmitter } from '../src/context-types.js'
import type { EnrollmentStore } from '../src/oauth'
import { registerEnrollmentHandlers } from '../src/features'

interface MockResponse {
  statusCode: number
  body: unknown
}

function invokeGetRoute(
  app: express.Application,
  path: string,
  query: Record<string, unknown> = {},
): Promise<MockResponse> {
  return new Promise((resolve, reject) => {
    let statusCode = 200
    const req = {
      query,
      headers: {},
      method: 'GET',
      url: path,
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

const NERV = 'did:web:nerv.tokyo.jp'

function storedEnrollment(
  did: string,
  overrides: Record<string, unknown> = {},
) {
  const row: Record<string, unknown> = {
    did,
    enrolledAt: '2026-01-01T00:00:00.000Z',
    pdsEndpoint: 'https://pds.example.com',
    signingKeyDid: 'did:key:zSailorMoon',
    active: true,
    isService: false,
    ...overrides,
  }
  // An explicit `undefined` override means the column is absent entirely.
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) delete row[key]
  }
  return row
}

function createCtx(opts: {
  enrollmentStore?: Partial<EnrollmentStore>
  adminAuthFails?: boolean
  idResolver?: AppContext['idResolver']
}): {
  app: express.Application
  enrollmentStore: AppContext['enrollmentStore']
  logger: { warn: ReturnType<typeof vi.fn> }
} {
  const enrollmentStore = {
    isEnrolled: vi.fn(async () => true),
    getEnrollment: vi.fn(),
    enroll: vi.fn(async () => {}),
    unenroll: vi.fn(async () => {}),
    updateEnrollment: vi.fn(async () => {}),
    getBoundaries: vi.fn(async () => [`${NERV}/general`]),
    setBoundaries: vi.fn(async () => {}),
    addBoundary: vi.fn(async () => {}),
    removeBoundary: vi.fn(async () => {}),
    listEnrollments: vi.fn(async () => []),
    enrollmentCount: vi.fn(async () => 0),
    ...opts.enrollmentStore,
  } as unknown as AppContext['enrollmentStore']

  const app = express()
  const enrollmentEvents: EnrollmentEventEmitter = new EventEmitter()

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
  const ctx = {
    app,
    enrollmentStore,
    enrollmentEvents,
    enrollmentService: {
      isEnrolled: enrollmentStore.isEnrolled,
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
    serviceDid: NERV,
    idResolver:
      opts.idResolver ??
      ({
        did: { resolve: vi.fn(async () => undefined) },
      } as unknown as AppContext['idResolver']),
    cfg: {
      service: { publicUrl: 'https://stratos.example.com' },
      stratos: { serviceDid: NERV, allowedDomains: [`${NERV}/general`] },
    },
    logger,
  } as unknown as AppContext

  registerEnrollmentHandlers({ method: vi.fn() } as never, ctx)
  return { app, enrollmentStore, logger }
}

const ROUTE = '/xrpc/zone.stratos.admin.listEnrollments'

describe('GET /xrpc/zone.stratos.admin.listEnrollments', () => {
  it('rejects unauthenticated callers', async () => {
    const { app, enrollmentStore } = createCtx({ adminAuthFails: true })

    const res = await invokeGetRoute(app, ROUTE)

    expect(res.statusCode).toBe(401)
    expect(enrollmentStore.listEnrollments).not.toHaveBeenCalled()
  })

  it('returns enrollments with their boundaries', async () => {
    const { app } = createCtx({
      enrollmentStore: {
        listEnrollments: vi.fn(async () => [
          storedEnrollment('did:plc:usagi'),
          storedEnrollment('did:plc:motoko', { isService: true }),
          // Older rows predate the isService column, so the key is absent
          // rather than false; the handler must still report a boolean.
          storedEnrollment('did:plc:faye', {
            isService: undefined,
            custody: 'pds',
            repoHost: 'https://pds.faye.example',
          }),
        ]),
        getBoundaries: vi.fn(async (did: string) =>
          did === 'did:plc:usagi'
            ? [`${NERV}/general`, `${NERV}/swordsmith`]
            : [`${NERV}/general`],
        ),
        enrollmentCount: vi.fn(async () => 3),
      } as unknown as Partial<EnrollmentStore>,
    })

    const res = await invokeGetRoute(app, ROUTE)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      enrollments: [
        {
          did: 'did:plc:usagi',
          enrolledAt: '2026-01-01T00:00:00.000Z',
          active: true,
          isService: false,
          custody: 'stratos',
          boundaries: [`${NERV}/general`, `${NERV}/swordsmith`],
        },
        {
          did: 'did:plc:motoko',
          enrolledAt: '2026-01-01T00:00:00.000Z',
          active: true,
          isService: true,
          custody: 'stratos',
          boundaries: [`${NERV}/general`],
        },
        {
          did: 'did:plc:faye',
          enrolledAt: '2026-01-01T00:00:00.000Z',
          active: true,
          isService: false,
          custody: 'pds',
          repoHost: 'https://pds.faye.example',
          boundaries: [`${NERV}/general`],
        },
      ],
      cursor: undefined,
      total: 3,
    })
  })

  it('defaults to a limit of 50 and passes the cursor through', async () => {
    const listEnrollments = vi.fn(async () => [])
    const { app } = createCtx({
      enrollmentStore: {
        listEnrollments,
      } as unknown as Partial<EnrollmentStore>,
    })

    await invokeGetRoute(app, ROUTE, { cursor: 'did:plc:asuka' })

    // Over-fetches by one to detect whether another page exists.
    expect(listEnrollments).toHaveBeenCalledWith({
      limit: 51,
      cursor: 'did:plc:asuka',
    })
  })

  it('returns a cursor only when another page exists', async () => {
    const { app } = createCtx({
      enrollmentStore: {
        // Three rows for a limit of 2: the extra row signals a next page.
        listEnrollments: vi.fn(async () => [
          storedEnrollment('did:plc:rei'),
          storedEnrollment('did:plc:shinji'),
          storedEnrollment('did:plc:asuka'),
        ]),
        enrollmentCount: vi.fn(async () => 5),
      } as unknown as Partial<EnrollmentStore>,
    })

    const res = await invokeGetRoute(app, ROUTE, { limit: '2' })
    const body = res.body as { enrollments: unknown[]; cursor?: string }
    expect(body.enrollments).toHaveLength(2)
    expect(body.cursor).toBe('did:plc:shinji')
  })

  it('omits the cursor on a final page that exactly fills the limit', async () => {
    const { app } = createCtx({
      enrollmentStore: {
        listEnrollments: vi.fn(async () => [
          storedEnrollment('did:plc:rei'),
          storedEnrollment('did:plc:shinji'),
        ]),
        enrollmentCount: vi.fn(async () => 2),
      } as unknown as Partial<EnrollmentStore>,
    })

    const res = await invokeGetRoute(app, ROUTE, { limit: '2' })
    const body = res.body as { enrollments: unknown[]; cursor?: string }
    expect(body.enrollments).toHaveLength(2)
    expect(body.cursor).toBeUndefined()
  })

  it.each([['0'], ['101'], ['abc'], ['1.5']])(
    'rejects an out-of-range limit (%s)',
    async (limit) => {
      const { app, enrollmentStore } = createCtx({})

      const res = await invokeGetRoute(app, ROUTE, { limit })

      expect(res.statusCode).toBe(400)
      expect(enrollmentStore.listEnrollments).not.toHaveBeenCalled()
    },
  )

  it('rejects a non-scalar limit', async () => {
    const { app, enrollmentStore } = createCtx({})

    // `?limit[]=1` parses to an array, which Number() would coerce to 1.
    const res = await invokeGetRoute(app, ROUTE, { limit: ['1'] })

    expect(res.statusCode).toBe(400)
    expect(enrollmentStore.listEnrollments).not.toHaveBeenCalled()
  })

  it('rejects a non-scalar cursor', async () => {
    const { app, enrollmentStore } = createCtx({})

    const res = await invokeGetRoute(app, ROUTE, { cursor: ['did:plc:rei'] })

    expect(res.statusCode).toBe(400)
    expect(enrollmentStore.listEnrollments).not.toHaveBeenCalled()
  })

  it('reports a store failure as an internal error', async () => {
    const { app } = createCtx({
      enrollmentStore: {
        listEnrollments: vi.fn(async () => {
          throw new Error('database is on fire')
        }),
      } as unknown as Partial<EnrollmentStore>,
    })

    const res = await invokeGetRoute(app, ROUTE)

    expect(res.statusCode).toBe(500)
    expect((res.body as { error: string }).error).toBe('InternalError')
  })

  describe('boundary filter', () => {
    /** A store whose members hold alternating boundaries. */
    function alternatingStore(dids: string[]) {
      return {
        listEnrollments: vi.fn(async (opts?: { cursor?: string }) => {
          const start = opts?.cursor ? dids.indexOf(opts.cursor) + 1 : 0
          return dids.slice(start).map((did) => storedEnrollment(did))
        }),
        getBoundaries: vi.fn(async (did: string) =>
          dids.indexOf(did) % 2 === 0
            ? [`${NERV}/general`, `${NERV}/swordsmith`]
            : [`${NERV}/general`],
        ),
        enrollmentCount: vi.fn(async () => dids.length),
      } as unknown as Partial<EnrollmentStore>
    }

    it('returns only members holding the boundary', async () => {
      const { app } = createCtx({
        enrollmentStore: alternatingStore([
          'did:plc:a',
          'did:plc:b',
          'did:plc:c',
          'did:plc:d',
        ]),
      })

      const res = await invokeGetRoute(app, ROUTE, {
        boundary: `${NERV}/swordsmith`,
      })

      const body = res.body as { enrollments: Array<{ did: string }> }
      expect(body.enrollments.map((e) => e.did)).toEqual([
        'did:plc:a',
        'did:plc:c',
      ])
    })

    it('omits the total, which would report the unfiltered count', async () => {
      const { app } = createCtx({
        enrollmentStore: alternatingStore(['did:plc:a', 'did:plc:b']),
      })

      const res = await invokeGetRoute(app, ROUTE, {
        boundary: `${NERV}/swordsmith`,
      })

      expect((res.body as { total?: number }).total).toBeUndefined()
    })

    it('paginates on matches, not on rows scanned', async () => {
      const dids = Array.from({ length: 10 }, (_, i) => `did:plc:m${i}`)
      const { app } = createCtx({ enrollmentStore: alternatingStore(dids) })

      const first = await invokeGetRoute(app, ROUTE, {
        boundary: `${NERV}/swordsmith`,
        limit: '2',
      })
      const firstBody = first.body as {
        enrollments: Array<{ did: string }>
        cursor?: string
      }
      expect(firstBody.enrollments.map((e) => e.did)).toEqual([
        'did:plc:m0',
        'did:plc:m2',
      ])
      expect(firstBody.cursor).toBe('did:plc:m2')

      // Resuming from the last match continues after it without repeats.
      const second = await invokeGetRoute(app, ROUTE, {
        boundary: `${NERV}/swordsmith`,
        limit: '2',
        cursor: firstBody.cursor!,
      })
      const secondBody = second.body as { enrollments: Array<{ did: string }> }
      expect(secondBody.enrollments.map((e) => e.did)).toEqual([
        'did:plc:m4',
        'did:plc:m6',
      ])
    })

    it('returns an empty page when nothing holds the boundary', async () => {
      const { app } = createCtx({
        enrollmentStore: alternatingStore(['did:plc:a', 'did:plc:b']),
      })

      const res = await invokeGetRoute(app, ROUTE, {
        boundary: `${NERV}/nobody-here`,
      })

      const body = res.body as { enrollments: unknown[]; cursor?: string }
      expect(body.enrollments).toEqual([])
      expect(body.cursor).toBeUndefined()
    })

    it('filters by active state', async () => {
      const { app } = createCtx({
        enrollmentStore: {
          listEnrollments: vi.fn(async () => [
            storedEnrollment('did:plc:a'),
            storedEnrollment('did:plc:b', { active: false }),
            storedEnrollment('did:plc:c', { active: false }),
          ]),
          enrollmentCount: vi.fn(async () => 3),
        } as unknown as Partial<EnrollmentStore>,
      })

      const inactive = await invokeGetRoute(app, ROUTE, { active: 'false' })
      const inactiveBody = inactive.body as {
        enrollments: Array<{ did: string }>
        total?: number
      }
      expect(inactiveBody.enrollments.map((e) => e.did)).toEqual([
        'did:plc:b',
        'did:plc:c',
      ])
      expect(inactiveBody.total).toBeUndefined()

      const active = await invokeGetRoute(app, ROUTE, { active: 'true' })
      expect(
        (
          active.body as { enrollments: Array<{ did: string }> }
        ).enrollments.map((e) => e.did),
      ).toEqual(['did:plc:a'])
    })

    it('combines the boundary and active filters', async () => {
      const { app } = createCtx({
        enrollmentStore: {
          listEnrollments: vi.fn(async () => [
            storedEnrollment('did:plc:a'),
            storedEnrollment('did:plc:b', { active: false }),
          ]),
          getBoundaries: vi.fn(async () => [`${NERV}/swordsmith`]),
          enrollmentCount: vi.fn(async () => 2),
        } as unknown as Partial<EnrollmentStore>,
      })

      const res = await invokeGetRoute(app, ROUTE, {
        boundary: `${NERV}/swordsmith`,
        active: 'false',
      })

      expect(
        (res.body as { enrollments: Array<{ did: string }> }).enrollments.map(
          (e) => e.did,
        ),
      ).toEqual(['did:plc:b'])
    })

    it.each([['yes'], [''], [['true']]])(
      'rejects a malformed active value (%o)',
      async (value) => {
        const { app, enrollmentStore } = createCtx({})

        const res = await invokeGetRoute(app, ROUTE, { active: value })

        expect(res.statusCode).toBe(400)
        expect(enrollmentStore.listEnrollments).not.toHaveBeenCalled()
      },
    )

    it('filters by custody and defaults absent custody to stratos', async () => {
      const { app } = createCtx({
        enrollmentStore: {
          listEnrollments: vi.fn(async () => [
            storedEnrollment('did:plc:usagi'),
            storedEnrollment('did:plc:rei', {
              custody: 'pds',
              repoHost: 'https://pds.rei.example',
            }),
          ]),
          enrollmentCount: vi.fn(async () => 2),
        } as unknown as Partial<EnrollmentStore>,
      })

      const stratos = await invokeGetRoute(app, ROUTE, { custody: 'stratos' })
      const pds = await invokeGetRoute(app, ROUTE, { custody: 'pds' })

      expect(
        (stratos.body as { enrollments: Array<{ did: string }> }).enrollments,
      ).toEqual([
        expect.objectContaining({ did: 'did:plc:usagi', custody: 'stratos' }),
      ])
      expect(
        (pds.body as { enrollments: Array<{ did: string }> }).enrollments,
      ).toEqual([
        expect.objectContaining({
          did: 'did:plc:rei',
          custody: 'pds',
          repoHost: 'https://pds.rei.example',
        }),
      ])
    })

    it.each([['unknown'], [['pds']]])(
      'rejects a malformed custody value (%o)',
      async (custody) => {
        const { app, enrollmentStore } = createCtx({})

        const res = await invokeGetRoute(app, ROUTE, { custody })

        expect(res.statusCode).toBe(400)
        expect(enrollmentStore.listEnrollments).not.toHaveBeenCalled()
      },
    )

    it('bounds the scan when nothing matches, and stays resumable', async () => {
      // 5000 members, none matching: without a budget this would scan the
      // whole table and issue a boundary read per row.
      const dids = Array.from({ length: 5000 }, (_, i) => `did:plc:z${i}`)
      const listEnrollments = vi.fn(
        async (opts?: { limit?: number; cursor?: string }) => {
          const start = opts?.cursor ? dids.indexOf(opts.cursor) + 1 : 0
          return dids
            .slice(start, start + (opts?.limit ?? 100))
            .map((did) => storedEnrollment(did))
        },
      )
      const { app } = createCtx({
        enrollmentStore: {
          listEnrollments,
          getBoundaries: vi.fn(async () => [`${NERV}/general`]),
          enrollmentCount: vi.fn(async () => dids.length),
        } as unknown as Partial<EnrollmentStore>,
      })

      const res = await invokeGetRoute(app, ROUTE, {
        boundary: `${NERV}/nobody-here`,
      })
      const body = res.body as { enrollments: unknown[]; cursor?: string }

      expect(body.enrollments).toEqual([])
      // Budget is 1000 rows in chunks of 100.
      expect(listEnrollments).toHaveBeenCalledTimes(10)
      // A cursor is returned so the remaining rows are still reachable.
      expect(body.cursor).toBe('did:plc:z999')

      const resumed = await invokeGetRoute(app, ROUTE, {
        boundary: `${NERV}/nobody-here`,
        cursor: body.cursor!,
      })
      // Resuming continues past the budget rather than restarting from the top.
      expect((resumed.body as { cursor?: string }).cursor).toBe('did:plc:z1999')
    })

    it.each([[''], [['a']]])('rejects a malformed boundary', async (value) => {
      const { app, enrollmentStore } = createCtx({})

      const res = await invokeGetRoute(app, ROUTE, { boundary: value })

      expect(res.statusCode).toBe(400)
      expect(enrollmentStore.listEnrollments).not.toHaveBeenCalled()
    })
  })
})

const HOST_ROUTE = '/xrpc/zone.stratos.admin.getRepoHost'

describe('GET /xrpc/zone.stratos.admin.getRepoHost', () => {
  it('returns one authority override for every member space', async () => {
    const { app } = createCtx({
      enrollmentStore: {
        getEnrollment: vi.fn(async () =>
          storedEnrollment('did:plc:usagi', {
            custody: 'pds',
            repoHost: 'https://override.example',
          }),
        ),
        getBoundaries: vi.fn(async () => [
          `${NERV}/general`,
          `${NERV}/swordsmith`,
        ]),
      } as unknown as Partial<EnrollmentStore>,
    })

    const res = await invokeGetRoute(app, HOST_ROUTE, { did: 'did:plc:usagi' })

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      did: 'did:plc:usagi',
      custody: 'pds',
      isService: false,
      resolutions: [
        {
          boundary: `${NERV}/general`,
          spaceUri: `at://${NERV}/space/zone.stratos.space.feed/general`,
          host: 'https://override.example',
          source: 'authority-override',
        },
        {
          boundary: `${NERV}/swordsmith`,
          spaceUri: `at://${NERV}/space/zone.stratos.space.feed/swordsmith`,
          host: 'https://override.example',
          source: 'authority-override',
        },
      ],
    })
  })

  it('falls back to the DID document and keeps unresolved spaces', async () => {
    const { app } = createCtx({
      enrollmentStore: {
        getEnrollment: vi.fn(async () =>
          storedEnrollment('did:plc:rei', { custody: 'pds' }),
        ),
        getBoundaries: vi.fn(async () => [
          `${NERV}/general`,
          `${NERV}/swordsmith`,
        ]),
      } as unknown as Partial<EnrollmentStore>,
      idResolver: {
        did: {
          resolve: vi.fn(async () => ({
            service: [
              {
                id: '#atproto_pds',
                serviceEndpoint: 'https://pds.rei.example',
              },
            ],
          })),
        },
      } as unknown as AppContext['idResolver'],
    })

    const resolved = await invokeGetRoute(app, HOST_ROUTE, {
      did: 'did:plc:rei',
    })
    expect(resolved.body).toEqual({
      did: 'did:plc:rei',
      custody: 'pds',
      isService: false,
      resolutions: [
        {
          boundary: `${NERV}/general`,
          spaceUri: `at://${NERV}/space/zone.stratos.space.feed/general`,
          host: 'https://pds.rei.example',
          source: 'did-document',
        },
        {
          boundary: `${NERV}/swordsmith`,
          spaceUri: `at://${NERV}/space/zone.stratos.space.feed/swordsmith`,
          host: 'https://pds.rei.example',
          source: 'did-document',
        },
      ],
    })

    const { app: unresolvedApp } = createCtx({
      enrollmentStore: {
        getEnrollment: vi.fn(async () =>
          storedEnrollment('did:plc:rei', { custody: 'pds' }),
        ),
        getBoundaries: vi.fn(async () => [`${NERV}/general`]),
      } as unknown as Partial<EnrollmentStore>,
    })
    const unresolved = await invokeGetRoute(unresolvedApp, HOST_ROUTE, {
      did: 'did:plc:rei',
    })
    expect(unresolved.body).toEqual({
      did: 'did:plc:rei',
      custody: 'pds',
      isService: false,
      resolutions: [
        {
          boundary: `${NERV}/general`,
          spaceUri: `at://${NERV}/space/zone.stratos.space.feed/general`,
        },
      ],
    })
  })

  it('warns when a member boundary cannot convert to a space URI', async () => {
    const boundary = 'unresolved-space'
    const { app, logger } = createCtx({
      enrollmentStore: {
        getEnrollment: vi.fn(async () =>
          storedEnrollment('did:plc:rei', { custody: 'pds' }),
        ),
        getBoundaries: vi.fn(async () => [boundary]),
      } as unknown as Partial<EnrollmentStore>,
    })

    const res = await invokeGetRoute(app, HOST_ROUTE, { did: 'did:plc:rei' })

    expect(res.body).toEqual({
      did: 'did:plc:rei',
      custody: 'pds',
      isService: false,
      resolutions: [],
    })
    expect(logger.warn).toHaveBeenCalledWith(
      { did: 'did:plc:rei', boundary },
      'admin.getRepoHost could not convert boundary to a space URI',
    )
  })

  it('returns no host resolution for stratos or service enrollment', async () => {
    for (const enrollment of [
      storedEnrollment('did:plc:motoko'),
      storedEnrollment('did:plc:batou', {
        custody: 'pds',
        isService: true,
        repoHost: 'https://service.example',
      }),
    ]) {
      const { app } = createCtx({
        enrollmentStore: {
          getEnrollment: vi.fn(async () => enrollment),
        } as unknown as Partial<EnrollmentStore>,
      })
      const res = await invokeGetRoute(app, HOST_ROUTE, { did: enrollment.did })
      expect(res.body).toEqual({
        did: enrollment.did,
        custody: enrollment.custody ?? 'stratos',
        isService: enrollment.isService ?? false,
        resolutions: [],
      })
    }
  })

  it('rejects unauthenticated callers', async () => {
    const { app, enrollmentStore } = createCtx({ adminAuthFails: true })

    expect(
      (await invokeGetRoute(app, HOST_ROUTE, { did: 'did:plc:rei' }))
        .statusCode,
    ).toBe(401)
    expect(enrollmentStore.getEnrollment).not.toHaveBeenCalled()
  })

  it('rejects invalid DID input and returns 404 for an unknown enrollment', async () => {
    const { app, enrollmentStore } = createCtx({})

    expect((await invokeGetRoute(app, HOST_ROUTE)).statusCode).toBe(400)
    expect(
      (await invokeGetRoute(app, HOST_ROUTE, { did: ['did:plc:rei'] }))
        .statusCode,
    ).toBe(400)
    expect(
      (await invokeGetRoute(app, HOST_ROUTE, { did: 'not-a-did' })).statusCode,
    ).toBe(400)
    expect(enrollmentStore.getEnrollment).not.toHaveBeenCalled()
    expect(
      (await invokeGetRoute(app, HOST_ROUTE, { did: 'did:plc:rei' }))
        .statusCode,
    ).toBe(404)
  })
})
