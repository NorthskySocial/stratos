import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { pino } from 'pino'
import type { Logger } from '@northskysocial/stratos-core'
import {
  asMember,
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  HARNESS_LEADERSHIP,
  startPostgresWriteHarness,
  startSqliteWriteHarness,
  withCredential,
  type WriteHarness,
} from './helpers/write-harness.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const PILOT = 'did:plc:shinji-ikari'
const RIVAL = 'did:plc:asuka-langley'
const WATCHER = 'did:plc:kaworu-nagisa'
const STRANGER = 'did:plc:gendo-ikari'
const COLLECTION = 'zone.stratos.feed.post'
const DOMAINS_TYPE = 'zone.stratos.boundary.defs#Domains'
const OTHER_SERVICE_BOUNDARY = 'did:web:seele.example/engineering'
const MAX_WRITES = 300

const uriOf = (rkey: string, did = PILOT) => `at://${did}/${COLLECTION}/${rkey}`

function claim(boundary: string) {
  return { $type: DOMAINS_TYPE, values: [{ value: boundary }] }
}

function post(text: string, bodyBoundary?: unknown) {
  return {
    $type: COLLECTION,
    text,
    createdAt: '1996-10-04T00:00:00.000Z',
    ...(bodyBoundary === undefined ? {} : { boundary: bodyBoundary }),
  }
}

const TYPE_FAULTS: Array<
  [string, (record: Record<string, unknown>) => unknown]
> = [
  ['no type', ({ $type: _type, ...rest }) => rest],
  ['a type that is not a string', (record) => ({ ...record, $type: 7 })],
  [
    'a type of another collection',
    (record) => ({ ...record, $type: 'app.bsky.feed.post' }),
  ],
]

interface Procedure {
  name: string
  nsid: string
  /** The request body; every field can be overridden by the case under test. */
  body(fields: Record<string, unknown>): Record<string, unknown>
}

const PROCEDURES: Procedure[] = [
  {
    name: 'createRecord',
    nsid: 'zone.stratos.repo.createRecord',
    body: (fields) => ({
      boundary: HARNESS_ENGINEERING,
      repo: PILOT,
      collection: COLLECTION,
      rkey: 'eva00',
      record: post('Sortie'),
      ...fields,
    }),
  },
  {
    name: 'putRecord',
    nsid: 'zone.stratos.repo.putRecord',
    body: (fields) => ({
      boundary: HARNESS_ENGINEERING,
      repo: PILOT,
      collection: COLLECTION,
      rkey: 'eva00',
      record: post('Sortie'),
      ...fields,
    }),
  },
]

const CREATE = PROCEDURES[0]
const PUT = PROCEDURES[1]

function defineWriteScenarios(
  getHarness: () => WriteHarness,
  procedure: Procedure,
) {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = getHarness()
    await harness.enrollMember(PILOT, [HARNESS_ENGINEERING, HARNESS_DESIGN])
  })

  const send = (fields: Record<string, unknown> = {}, did = PILOT) =>
    harness.call(procedure.nsid, asMember(did), procedure.body(fields))

  async function seed(rkey: string, boundary = HARNESS_ENGINEERING) {
    const seeded = await harness.call(
      'com.atproto.repo.createRecord',
      asMember(PILOT),
      {
        repo: PILOT,
        collection: COLLECTION,
        rkey,
        record: post(`seed ${rkey}`, claim(boundary)),
      },
    )
    expect(seeded.status).toBe(200)
  }

  async function snapshot(rkey: string) {
    return {
      rows: await harness.recordRows(uriOf(rkey)),
      root: await harness.repoRoot(PILOT),
      ops: await harness.sequencedOps(PILOT),
    }
  }

  it('succeeds with exactly uri and cid', async () => {
    const response = await send()

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      uri: uriOf('eva00'),
      cid: expect.any(String),
      validationStatus: 'valid',
    })
    expect((await harness.recordRows(uriOf('eva00'))).boundaries).toEqual([
      HARNESS_ENGINEERING,
    ])
  })

  it('sequences the op with the boundary of the request', async () => {
    await send()

    expect(await harness.sequencedOps(PILOT)).toEqual([
      expect.objectContaining({
        action: 'create',
        path: `${COLLECTION}/eva00`,
        scope: [HARNESS_ENGINEERING],
      }),
    ])
  })

  it('accepts the validate flag', async () => {
    expect((await send({ validate: false })).status).toBe(200)
  })

  it('stores a body that claims the request boundary', async () => {
    const response = await send({
      record: post('Sortie', claim(HARNESS_ENGINEERING)),
    })

    expect(response.status).toBe(200)
  })

  it('refuses a body that claims another boundary with BoundaryMismatch', async () => {
    const before = await snapshot('eva00')

    const response = await send({
      record: post('Sortie', claim(HARNESS_DESIGN)),
    })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: 'BoundaryMismatch' })
    expect(await snapshot('eva00')).toEqual(before)
  })

  it.each(TYPE_FAULTS)(
    'refuses a record with %s with InvalidRecord and stores nothing',
    async (_fault, damage) => {
      await seed('eva-old')
      const before = await snapshot('eva00')

      const response = await send({ record: damage(post('Sortie')) })

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'InvalidRecord' })
      expect(await snapshot('eva00')).toEqual(before)
    },
  )

  it('refuses a request that still says space instead of boundary', async () => {
    const { boundary: _boundary, ...withoutBoundary } = procedure.body({})

    const response = await harness.call(procedure.nsid, asMember(PILOT), {
      ...withoutBoundary,
      space: HARNESS_ENGINEERING,
    })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: 'InvalidRequest' })
    expect((await harness.recordRows(uriOf('eva00'))).record).toBeNull()
  })

  it('refuses a repo that is not the caller with 401', async () => {
    const before = await snapshot('eva00')

    const response = await send({ repo: RIVAL })

    expect(response.status).toBe(401)
    expect(response.body).toMatchObject({ error: 'AuthenticationRequired' })
    expect(await snapshot('eva00')).toEqual(before)
  })

  it('refuses a collection the hosted space type does not allow', async () => {
    const response = await send({ collection: 'app.bsky.feed.post' })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: 'InvalidCollection' })
  })

  describe('refusals that name the rule', () => {
    it('refuses a caller who is not enrolled with NotEnrolled', async () => {
      const response = await send({ repo: STRANGER }, STRANGER)

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'NotEnrolled' })
    })

    it('refuses a service identity with ServiceWriteForbidden', async () => {
      await harness.enrollServiceIdentity('did:web:magi.nerv.tokyo.jp', [
        HARNESS_ENGINEERING,
      ])

      const response = await send(
        { repo: 'did:web:magi.nerv.tokyo.jp' },
        'did:web:magi.nerv.tokyo.jp',
      )

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'ServiceWriteForbidden' })
    })

    it('refuses a pds custody member with PdsCustodyWriteForbidden', async () => {
      await harness.enrollPdsCustodyMember('did:plc:misato-katsuragi', [
        HARNESS_ENGINEERING,
      ])

      const response = await send(
        { repo: 'did:plc:misato-katsuragi' },
        'did:plc:misato-katsuragi',
      )

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({
        error: 'PdsCustodyWriteForbidden',
      })
    })

    it.each([
      [
        'a boundary of another service',
        OTHER_SERVICE_BOUNDARY,
        'ServiceMismatch',
      ],
      ['a malformed boundary name', 'Not A Skey!', 'InvalidDomain'],
      [
        'a boundary the caller does not hold',
        HARNESS_LEADERSHIP,
        'ForbiddenBoundary',
      ],
    ])('refuses %s with %s', async (_name, boundary, error) => {
      const before = await snapshot('eva00')

      const response = await send({ boundary })

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error })
      expect(await snapshot('eva00')).toEqual(before)
    })

    it('refuses a member held after authentication with NotEnrolled', async () => {
      const locks = harness.ctx.repoWriteLocks
      const realAcquire = locks.acquire.bind(locks)
      let armed = true
      const acquire = vi
        .spyOn(locks, 'acquire')
        .mockImplementation(async (did) => {
          if (armed) {
            armed = false
            await harness.holdMember(PILOT)
          }
          return realAcquire(did)
        })
      const before = await snapshot('eva00')

      try {
        const response = await send()

        expect(response.status).toBe(400)
        expect(response.body).toMatchObject({ error: 'NotEnrolled' })
      } finally {
        acquire.mockRestore()
      }
      expect(await snapshot('eva00')).toEqual(before)
    })

    it('refuses a real space credential', async () => {
      const credential = await harness.mintSpaceCredential(
        PILOT,
        HARNESS_ENGINEERING,
      )

      const response = await harness.call(
        procedure.nsid,
        withCredential(credential),
        procedure.body({}),
      )

      expect(response.status).toBe(401)
      expect(response.body).toEqual({
        error: 'AuthenticationRequired',
        message: 'Authorization failed',
      })
      expect((await harness.recordRows(uriOf('eva00'))).record).toBeNull()
    })
  })

  it('charges the rate limiter and answers 429 once the limit is spent', async () => {
    harness.ctx.writeRateLimiter.assertWriteAllowed(PILOT, MAX_WRITES - 1)

    const last = await send({ rkey: 'eva01' })
    const refused = await send({ rkey: 'eva02' })

    expect(last.status).toBe(200)
    expect(refused.status).toBe(429)
    expect(refused.body).toMatchObject({ error: 'RateLimitExceeded' })
    expect((await harness.recordRows(uriOf('eva02'))).record).toBeNull()
  })

  if (procedure === CREATE) {
    it('refuses a create on a key that is taken, in any boundary, with RecordAlreadyExists', async () => {
      await seed('eva00')
      await seed('eva01', HARNESS_DESIGN)

      for (const rkey of ['eva00', 'eva01']) {
        const before = await snapshot(rkey)

        const response = await send({ rkey })

        expect(response.status).toBe(400)
        expect(response.body).toMatchObject({ error: 'RecordAlreadyExists' })
        expect(await snapshot(rkey)).toEqual(before)
      }
    })

    it('gives a create without a key a fresh record key', async () => {
      const { rkey: _rkey, ...withoutKey } = procedure.body({})

      const response = await harness.call(
        procedure.nsid,
        asMember(PILOT),
        withoutKey,
      )

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        uri: expect.stringMatching(
          new RegExp(`^at://${PILOT}/${COLLECTION}/[2-7a-z]{13}$`),
        ),
      })
    })
  }

  if (procedure === PUT) {
    it('updates a record held in the boundary with an update op', async () => {
      await seed('eva00')

      const response = await send({ record: post('Berserk') })

      expect(response.status).toBe(200)
      expect(
        (await harness.recordRows(uriOf('eva00'))).record?.value,
      ).toMatchObject({ text: 'Berserk' })
      expect(
        (await harness.sequencedOps(PILOT)).map((op) => op.action),
      ).toEqual(['create', 'update'])
    })

    it('refuses a put on a key held in another boundary with RecordAlreadyExists', async () => {
      await seed('eva00', HARNESS_DESIGN)
      const before = await snapshot('eva00')

      const response = await send({ record: post('Berserk') })

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'RecordAlreadyExists' })
      expect(await snapshot('eva00')).toEqual(before)
    })
  }
}

function defineReadScenarios(getHarness: () => WriteHarness) {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = getHarness()
    await harness.enrollMember(PILOT, [HARNESS_ENGINEERING, HARNESS_DESIGN])
    await harness.enrollMember(RIVAL, [HARNESS_ENGINEERING])
    await harness.enrollMember(WATCHER, [HARNESS_DESIGN])
  })

  describe.each(PROCEDURES)(
    'a record from $name with no body boundary',
    (procedure) => {
      beforeEach(async () => {
        const response = await harness.call(
          procedure.nsid,
          asMember(PILOT),
          procedure.body({}),
        )
        expect(response.status).toBe(200)
      })

      const uri = uriOf('eva00')
      const readParams = { repo: PILOT, collection: COLLECTION, rkey: 'eva00' }

      it('is readable through getRecord by a member of the boundary only', async () => {
        const member = await harness.query(
          'com.atproto.repo.getRecord',
          asMember(RIVAL),
          readParams,
        )
        const otherBoundary = await harness.query(
          'com.atproto.repo.getRecord',
          asMember(WATCHER),
          readParams,
        )
        const anonymous = await harness.query(
          'com.atproto.repo.getRecord',
          null,
          readParams,
        )

        expect(member.status).toBe(200)
        expect(member.body).toMatchObject({ uri, value: { text: 'Sortie' } })
        expect(otherBoundary.status).not.toBe(200)
        expect(anonymous.status).not.toBe(200)
      })

      it('is listed by listRecords for a member of the boundary only', async () => {
        const listed = async (auth: string | null) => {
          const response = await harness.query(
            'com.atproto.repo.listRecords',
            auth,
            { repo: PILOT, collection: COLLECTION },
          )
          expect(response.status).toBe(200)
          return (
            response.body as { records: Array<{ uri: string }> }
          ).records.map((entry) => entry.uri)
        }

        expect(await listed(asMember(RIVAL))).toEqual([uri])
        expect(await listed(asMember(WATCHER))).toEqual([])
        expect(await listed(null)).toEqual([])
      })

      it('is hydrated for a member of the boundary only', async () => {
        const hydrate = async (auth: string | null) => {
          const response = await harness.call(
            'zone.stratos.repo.hydrateRecords',
            auth,
            { uris: [uri] },
          )
          expect(response.status).toBe(200)
          return response.body as {
            records: Array<{ uri: string }>
            notFound: string[]
            blocked: string[]
          }
        }

        const member = await hydrate(asMember(RIVAL))
        const otherBoundary = await hydrate(asMember(WATCHER))
        const anonymous = await hydrate(null)

        expect(member.records.map((entry) => entry.uri)).toEqual([uri])
        expect(otherBoundary.records).toEqual([])
        expect(anonymous.records).toEqual([])
      })
    },
  )
}

const APPLY_WRITES_NSID = 'zone.stratos.repo.applyWrites'
const WRITE_TYPE = `${APPLY_WRITES_NSID}#`
const WRITES_LIMIT = 200

interface LogicalFields {
  boundary: string
  repo: string
  collection: string
  rkey: string
  record: unknown
}

interface RefusingProcedure {
  name: string
  nsid: string
  body(fields: Partial<LogicalFields>): Record<string, unknown>
}

const DELETE: RefusingProcedure = {
  name: 'deleteRecord',
  nsid: 'zone.stratos.repo.deleteRecord',
  body: (fields) => ({
    boundary: HARNESS_ENGINEERING,
    repo: PILOT,
    collection: COLLECTION,
    rkey: 'eva00',
    ...pick(fields, ['boundary', 'repo', 'collection', 'rkey']),
  }),
}

const APPLY_WRITES: RefusingProcedure = {
  name: 'applyWrites',
  nsid: APPLY_WRITES_NSID,
  body: (fields) => ({
    boundary: fields.boundary ?? HARNESS_ENGINEERING,
    repo: fields.repo ?? PILOT,
    writes: [
      createWrite(
        fields.rkey ?? 'eva00',
        fields.record ?? post('Sortie'),
        fields.collection,
      ),
    ],
  }),
}

function pick<T extends object>(source: T, keys: Array<keyof T>): Partial<T> {
  return Object.fromEntries(
    keys.filter((key) => key in source).map((key) => [key, source[key]]),
  ) as Partial<T>
}

function createWrite(rkey: string, value: unknown, collection = COLLECTION) {
  return { $type: `${WRITE_TYPE}create`, collection, rkey, value }
}

function updateWrite(rkey: string, value: unknown) {
  return { $type: `${WRITE_TYPE}update`, collection: COLLECTION, rkey, value }
}

function deleteWrite(rkey: string) {
  return { $type: `${WRITE_TYPE}delete`, collection: COLLECTION, rkey }
}

function defineRefusalScenarios(
  getHarness: () => WriteHarness,
  procedure: RefusingProcedure,
) {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = getHarness()
    await harness.enrollMember(PILOT, [HARNESS_ENGINEERING, HARNESS_DESIGN])
  })

  const send = (fields: Partial<LogicalFields> = {}, did = PILOT) =>
    harness.call(procedure.nsid, asMember(did), procedure.body(fields))

  async function snapshot() {
    return {
      rows: await harness.recordRows(uriOf('eva00')),
      root: await harness.repoRoot(PILOT),
      ops: await harness.sequencedOps(PILOT),
    }
  }

  it('refuses a caller who is not enrolled with NotEnrolled', async () => {
    const response = await send({ repo: STRANGER }, STRANGER)

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: 'NotEnrolled' })
  })

  it('refuses a service identity with ServiceWriteForbidden', async () => {
    await harness.enrollServiceIdentity('did:web:magi.nerv.tokyo.jp', [
      HARNESS_ENGINEERING,
    ])

    const response = await send(
      { repo: 'did:web:magi.nerv.tokyo.jp' },
      'did:web:magi.nerv.tokyo.jp',
    )

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: 'ServiceWriteForbidden' })
  })

  it('refuses a pds custody member with PdsCustodyWriteForbidden', async () => {
    await harness.enrollPdsCustodyMember('did:plc:misato-katsuragi', [
      HARNESS_ENGINEERING,
    ])

    const response = await send(
      { repo: 'did:plc:misato-katsuragi' },
      'did:plc:misato-katsuragi',
    )

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: 'PdsCustodyWriteForbidden' })
  })

  it.each([
    [
      'a boundary of another service',
      OTHER_SERVICE_BOUNDARY,
      'ServiceMismatch',
    ],
    ['a malformed boundary name', 'Not A Skey!', 'InvalidDomain'],
    [
      'a boundary the caller does not hold',
      HARNESS_LEADERSHIP,
      'ForbiddenBoundary',
    ],
  ])('refuses %s with %s', async (_name, boundary, error) => {
    const before = await snapshot()

    const response = await send({ boundary })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error })
    expect(await snapshot()).toEqual(before)
  })

  it('refuses a member held after authentication with NotEnrolled', async () => {
    const locks = harness.ctx.repoWriteLocks
    const realAcquire = locks.acquire.bind(locks)
    let armed = true
    const acquire = vi
      .spyOn(locks, 'acquire')
      .mockImplementation(async (did) => {
        if (armed) {
          armed = false
          await harness.holdMember(PILOT)
        }
        return realAcquire(did)
      })
    const before = await snapshot()

    try {
      const response = await send()

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'NotEnrolled' })
    } finally {
      acquire.mockRestore()
    }
    expect(await snapshot()).toEqual(before)
  })

  it('refuses a repo that is not the caller with 401', async () => {
    const before = await snapshot()

    const response = await send({ repo: RIVAL })

    expect(response.status).toBe(401)
    expect(response.body).toMatchObject({ error: 'AuthenticationRequired' })
    expect(await snapshot()).toEqual(before)
  })

  it('refuses a collection the hosted space type does not allow', async () => {
    const response = await send({ collection: 'app.bsky.feed.post' })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: 'InvalidCollection' })
  })

  it('refuses a real space credential', async () => {
    const credential = await harness.mintSpaceCredential(
      PILOT,
      HARNESS_ENGINEERING,
    )

    const response = await harness.call(
      procedure.nsid,
      withCredential(credential),
      procedure.body({}),
    )

    expect(response.status).toBe(401)
    expect(response.body).toEqual({
      error: 'AuthenticationRequired',
      message: 'Authorization failed',
    })
  })

  it('refuses a request that still says space instead of boundary', async () => {
    const { boundary: _boundary, ...withoutBoundary } = procedure.body({})

    const response = await harness.call(procedure.nsid, asMember(PILOT), {
      ...withoutBoundary,
      space: HARNESS_ENGINEERING,
    })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: 'InvalidRequest' })
  })

  it('answers 429 once the write limit is spent', async () => {
    harness.ctx.writeRateLimiter.assertWriteAllowed(PILOT, MAX_WRITES)

    const response = await send()

    expect(response.status).toBe(429)
    expect(response.body).toMatchObject({ error: 'RateLimitExceeded' })
  })
}

function defineDeleteScenarios(getHarness: () => WriteHarness) {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = getHarness()
    await harness.enrollMember(PILOT, [HARNESS_ENGINEERING, HARNESS_DESIGN])
  })

  const send = (fields: Partial<LogicalFields> = {}) =>
    harness.call(DELETE.nsid, asMember(PILOT), DELETE.body(fields))

  async function seed(rkey: string, boundary = HARNESS_ENGINEERING) {
    const seeded = await harness.call(
      'com.atproto.repo.createRecord',
      asMember(PILOT),
      {
        repo: PILOT,
        collection: COLLECTION,
        rkey,
        record: post(`seed ${rkey}`, claim(boundary)),
      },
    )
    expect(seeded.status).toBe(200)
  }

  async function takeDown(rkey: string) {
    await harness.ctx.actorStore.transact(PILOT, (store) =>
      store.record.updateRecordTakedown(uriOf(rkey), {
        applied: true,
        ref: 'takedown-nerv',
      }),
    )
  }

  it('deletes a record in the boundary with an empty body and the plain and scoped delete events', async () => {
    await seed('eva00')

    const response = await send()

    expect(response.status).toBe(200)
    expect(response.body).toEqual({})
    expect((await harness.recordRows(uriOf('eva00'))).record).toBeNull()
    const ops = (await harness.sequencedOps(PILOT)).slice(1)
    expect(ops.map(({ action, scope }) => ({ action, scope }))).toEqual([
      { action: 'delete', scope: [] },
      { action: 'delete', scope: [HARNESS_ENGINEERING] },
    ])
  })

  it('deletes a taken-down record', async () => {
    await seed('eva00')
    await takeDown('eva00')

    const response = await send()

    expect(response.status).toBe(200)
    expect((await harness.recordRows(uriOf('eva00'))).record).toBeNull()
  })

  it('answers a missing record and a record in another boundary with the same bytes and changes nothing', async () => {
    await seed('eva-design', HARNESS_DESIGN)
    const rootBefore = await harness.repoRoot(PILOT)
    const opsBefore = await harness.sequencedOps(PILOT)
    const rowsBefore = await harness.recordRows(uriOf('eva-design'))

    const missing = await send({ rkey: 'eva-missing' })
    const otherBoundary = await send({ rkey: 'eva-design' })

    expect(missing.status).toBe(200)
    expect(missing.body).toEqual({})
    expect(otherBoundary.status).toBe(missing.status)
    expect(JSON.stringify(otherBoundary.body)).toBe(
      JSON.stringify(missing.body),
    )
    expect(await harness.repoRoot(PILOT)).toEqual(rootBefore)
    expect(await harness.sequencedOps(PILOT)).toEqual(opsBefore)
    expect(await harness.recordRows(uriOf('eva-design'))).toEqual(rowsBefore)
  })

  it('charges the rate limiter one unit', async () => {
    const charge = vi.spyOn(harness.ctx.writeRateLimiter, 'assertWriteAllowed')
    try {
      await send({ rkey: 'eva-missing' })
      expect(charge).toHaveBeenCalledWith(PILOT, 1)
    } finally {
      charge.mockRestore()
    }
  })
}

function defineApplyWritesScenarios(getHarness: () => WriteHarness) {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = getHarness()
    await harness.enrollMember(PILOT, [HARNESS_ENGINEERING, HARNESS_DESIGN])
  })

  const send = (writes: unknown[], boundary = HARNESS_ENGINEERING) =>
    harness.call(APPLY_WRITES_NSID, asMember(PILOT), {
      boundary,
      repo: PILOT,
      writes,
    })

  async function seed(rkey: string, boundary = HARNESS_ENGINEERING) {
    const seeded = await harness.call(
      'com.atproto.repo.createRecord',
      asMember(PILOT),
      {
        repo: PILOT,
        collection: COLLECTION,
        rkey,
        record: post(`seed ${rkey}`, claim(boundary)),
      },
    )
    expect(seeded.status).toBe(200)
  }

  async function takeDown(rkey: string) {
    await harness.ctx.actorStore.transact(PILOT, (store) =>
      store.record.updateRecordTakedown(uriOf(rkey), {
        applied: true,
        ref: 'takedown-nerv',
      }),
    )
  }

  async function snapshot(rkeys: string[]) {
    return {
      rows: await Promise.all(
        rkeys.map((rkey) => harness.recordRows(uriOf(rkey))),
      ),
      root: await harness.repoRoot(PILOT),
      ops: await harness.sequencedOps(PILOT),
    }
  }

  it('applies a create, an update and a delete and types each result', async () => {
    await seed('eva-old')
    await seed('eva-gone')

    const response = await send([
      createWrite('eva-new', post('Sortie')),
      updateWrite('eva-old', post('Berserk')),
      deleteWrite('eva-gone'),
    ])

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      results: [
        {
          $type: `${WRITE_TYPE}createResult`,
          uri: uriOf('eva-new'),
          cid: expect.any(String),
          validationStatus: 'valid',
        },
        {
          $type: `${WRITE_TYPE}updateResult`,
          uri: uriOf('eva-old'),
          cid: expect.any(String),
          validationStatus: 'valid',
        },
        { $type: `${WRITE_TYPE}deleteResult` },
      ],
    })
    expect((await harness.recordRows(uriOf('eva-new'))).boundaries).toEqual([
      HARNESS_ENGINEERING,
    ])
    expect((await harness.recordRows(uriOf('eva-gone'))).record).toBeNull()
  })

  it('gives a create without a key a fresh record key', async () => {
    const response = await send([
      {
        $type: `${WRITE_TYPE}create`,
        collection: COLLECTION,
        value: post('Sortie'),
      },
    ])

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      results: [
        {
          uri: expect.stringMatching(
            new RegExp(`^at://${PILOT}/${COLLECTION}/[2-7a-z]{13}$`),
          ),
        },
      ],
    })
  })

  it('refuses a body boundary that disagrees with the request on create and update', async () => {
    await seed('eva-old')
    const before = await snapshot(['eva-new', 'eva-old'])

    for (const write of [
      createWrite('eva-new', post('Sortie', claim(HARNESS_DESIGN))),
      updateWrite('eva-old', post('Berserk', claim(HARNESS_DESIGN))),
    ]) {
      const response = await send([write])

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'BoundaryMismatch' })
    }
    expect(await snapshot(['eva-new', 'eva-old'])).toEqual(before)
  })

  it.each(TYPE_FAULTS)(
    'refuses a created or updated record with %s with InvalidRecord and stores nothing',
    async (_fault, damage) => {
      await seed('eva-old')
      const before = await snapshot(['eva-new', 'eva-old'])

      for (const write of [
        createWrite('eva-new', damage(post('Sortie'))),
        updateWrite('eva-old', damage(post('Berserk'))),
      ]) {
        const response = await send([write])

        expect(response.status).toBe(400)
        expect(response.body).toMatchObject({ error: 'InvalidRecord' })
      }
      expect(await snapshot(['eva-new', 'eva-old'])).toEqual(before)
    },
  )

  it('refuses a create on a key that is taken, in any boundary or taken down', async () => {
    await seed('eva-same')
    await seed('eva-design', HARNESS_DESIGN)
    await seed('eva-down')
    await takeDown('eva-down')

    for (const rkey of ['eva-same', 'eva-design', 'eva-down']) {
      const before = await snapshot([rkey])

      const response = await send([createWrite(rkey, post('Sortie'))])

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'RecordAlreadyExists' })
      expect(await snapshot([rkey])).toEqual(before)
    }
  })

  it('refuses an update of a missing, other-boundary or taken-down record with RecordNotFound', async () => {
    await seed('eva-design', HARNESS_DESIGN)
    await seed('eva-down')
    await takeDown('eva-down')

    for (const rkey of ['eva-missing', 'eva-design', 'eva-down']) {
      const before = await snapshot([rkey])

      const response = await send([updateWrite(rkey, post('Berserk'))])

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'RecordNotFound' })
      expect(await snapshot([rkey])).toEqual(before)
    }
  })

  it('refuses a delete of a missing or other-boundary record with RecordNotFound', async () => {
    await seed('eva-design', HARNESS_DESIGN)

    for (const rkey of ['eva-missing', 'eva-design']) {
      const before = await snapshot([rkey])

      const response = await send([deleteWrite(rkey)])

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'RecordNotFound' })
      expect(await snapshot([rkey])).toEqual(before)
    }
  })

  it('deletes a taken-down record', async () => {
    await seed('eva-down')
    await takeDown('eva-down')

    const response = await send([deleteWrite('eva-down')])

    expect(response.status).toBe(200)
    expect((await harness.recordRows(uriOf('eva-down'))).record).toBeNull()
  })

  it('stores nothing and sends no event when a later write fails', async () => {
    const before = await snapshot(['eva-new'])

    const response = await send([
      createWrite('eva-new', post('Sortie')),
      updateWrite('eva-missing', post('Berserk')),
    ])

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: 'RecordNotFound' })
    expect(await snapshot(['eva-new'])).toEqual(before)
  })

  it.each([
    [
      'two creates of one key',
      [createWrite('eva00', post('a')), createWrite('eva00', post('b'))],
    ],
    [
      'a create and a delete of one key',
      [createWrite('eva00', post('a')), deleteWrite('eva00')],
    ],
  ])('refuses %s with 400 and stores nothing', async (_name, writes) => {
    const before = await snapshot(['eva00'])

    const response = await send(writes)

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: 'InvalidRequest' })
    expect(await snapshot(['eva00'])).toEqual(before)
  })

  describe('the size of the batch', () => {
    let charge: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      charge = vi.spyOn(harness.ctx.writeRateLimiter, 'assertWriteAllowed')
    })

    afterEach(() => {
      charge.mockRestore()
    })

    it('refuses no writes with 400 from the input verifier, where the legacy procedure answers 500, before charging the limiter', async () => {
      const before = await snapshot([])

      const response = await send([])

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'InvalidRequest' })
      expect(charge).not.toHaveBeenCalled()
      expect(await snapshot([])).toEqual(before)
    })

    it('refuses one write too many with 400 before charging the limiter', async () => {
      const writes = Array.from({ length: WRITES_LIMIT + 1 }, (_, index) =>
        createWrite(`eva${index}`, post('Sortie')),
      )

      const response = await send(writes)

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'InvalidRequest' })
      expect(charge).not.toHaveBeenCalled()
      expect((await harness.recordRows(uriOf('eva0'))).record).toBeNull()
    })

    it('accepts the largest batch and charges one unit per write', async () => {
      const writes = Array.from({ length: WRITES_LIMIT }, (_, index) =>
        createWrite(`eva${index}`, post('Sortie')),
      )

      const response = await send(writes)

      expect(response.status).toBe(200)
      expect((response.body as { results: unknown[] }).results).toHaveLength(
        WRITES_LIMIT,
      )
      expect(charge).toHaveBeenCalledWith(PILOT, WRITES_LIMIT)
    })
  })
}

describe('boundary record writes over http on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  describe.each(PROCEDURES)('$name', (procedure) => {
    defineWriteScenarios(() => harness, procedure)
  })

  defineReadScenarios(() => harness)

  describe.each([DELETE, APPLY_WRITES])('$name', (procedure) => {
    defineRefusalScenarios(() => harness, procedure)
  })

  describe('deleteRecord', () => {
    defineDeleteScenarios(() => harness)
  })

  describe('applyWrites', () => {
    defineApplyWritesScenarios(() => harness)
  })
})

describe('boundary record writes over http on postgres', () => {
  let connectionString: string
  let harness: WriteHarness

  beforeAll(async () => {
    connectionString = await startPostgresContainer()
  }, 120_000)

  afterAll(async () => {
    await stopPostgresContainer()
  }, 60_000)

  beforeEach(async () => {
    harness = await startPostgresWriteHarness(connectionString)
    await harness.enrollMember(PILOT, [HARNESS_ENGINEERING])
  }, 60_000)

  afterEach(async () => {
    await harness.close()
  })

  describe.each(PROCEDURES)('$name', (procedure) => {
    it('succeeds with exactly uri and cid', async () => {
      const response = await harness.call(
        procedure.nsid,
        asMember(PILOT),
        procedure.body({}),
      )

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        uri: uriOf('eva00'),
        cid: expect.any(String),
        validationStatus: 'valid',
      })
      expect((await harness.recordRows(uriOf('eva00'))).boundaries).toEqual([
        HARNESS_ENGINEERING,
      ])
    })

    it('refuses a boundary the caller does not hold with ForbiddenBoundary', async () => {
      const response = await harness.call(
        procedure.nsid,
        asMember(PILOT),
        procedure.body({ boundary: HARNESS_LEADERSHIP }),
      )

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'ForbiddenBoundary' })
      expect((await harness.recordRows(uriOf('eva00'))).record).toBeNull()
    })
  })

  describe('deleteRecord', () => {
    it('deletes a record in the boundary with an empty body', async () => {
      await harness.call('com.atproto.repo.createRecord', asMember(PILOT), {
        repo: PILOT,
        collection: COLLECTION,
        rkey: 'eva00',
        record: post('Sortie', claim(HARNESS_ENGINEERING)),
      })

      const response = await harness.call(
        DELETE.nsid,
        asMember(PILOT),
        DELETE.body({}),
      )

      expect(response.status).toBe(200)
      expect(response.body).toEqual({})
      expect((await harness.recordRows(uriOf('eva00'))).record).toBeNull()
    })

    it('refuses a boundary the caller does not hold with ForbiddenBoundary', async () => {
      const response = await harness.call(
        DELETE.nsid,
        asMember(PILOT),
        DELETE.body({ boundary: HARNESS_LEADERSHIP }),
      )

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'ForbiddenBoundary' })
    })
  })

  describe('applyWrites', () => {
    it('applies a create and types its result', async () => {
      const response = await harness.call(APPLY_WRITES_NSID, asMember(PILOT), {
        boundary: HARNESS_ENGINEERING,
        repo: PILOT,
        writes: [createWrite('eva00', post('Sortie'))],
      })

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        results: [
          {
            $type: `${WRITE_TYPE}createResult`,
            uri: uriOf('eva00'),
            cid: expect.any(String),
            validationStatus: 'valid',
          },
        ],
      })
    })

    it('refuses an update of a missing record with RecordNotFound and stores nothing', async () => {
      const response = await harness.call(APPLY_WRITES_NSID, asMember(PILOT), {
        boundary: HARNESS_ENGINEERING,
        repo: PILOT,
        writes: [
          createWrite('eva00', post('Sortie')),
          updateWrite('eva-missing', post('Berserk')),
        ],
      })

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'RecordNotFound' })
      expect((await harness.recordRows(uriOf('eva00'))).record).toBeNull()
    })
  })
})

describe('boundary record writes log the business event', () => {
  interface LoggedLine {
    msg: string
    [field: string]: unknown
  }

  let harness: WriteHarness
  let lines: LoggedLine[]

  beforeEach(async () => {
    lines = []
    const sink = {
      write: (line: string) => {
        lines.push(JSON.parse(line) as LoggedLine)
      },
    }
    harness = await startSqliteWriteHarness({
      logger: pino({ level: 'info' }, sink) as unknown as Logger,
    })
    await harness.enrollMember(PILOT, [HARNESS_ENGINEERING, HARNESS_DESIGN])
  })

  afterEach(async () => {
    await harness.close()
  })

  const logged = (message: string) =>
    lines.filter((line) => line.msg === message)

  const createBody = (fields: Record<string, unknown> = {}) =>
    CREATE.body(fields)

  it('logs one record created line with the uri and a numeric duration per successful create', async () => {
    const response = await harness.call(
      CREATE.nsid,
      asMember(PILOT),
      createBody(),
    )

    expect(response.status).toBe(200)
    expect(logged('record created')).toEqual([
      expect.objectContaining({
        requestId: expect.any(String) as string,
        uri: uriOf('eva00'),
        durationMs: expect.any(Number) as number,
      }),
    ])
  })

  it('logs no record created line for a refused write', async () => {
    const response = await harness.call(
      CREATE.nsid,
      asMember(PILOT),
      createBody({ record: post('Sortie', claim(HARNESS_DESIGN)) }),
    )

    expect(response.status).toBe(400)
    expect(logged('record created')).toEqual([])
  })

  it('logs a record written line for a put', async () => {
    const response = await harness.call(PUT.nsid, asMember(PILOT), PUT.body({}))

    expect(response.status).toBe(200)
    expect(logged('record written')).toEqual([
      expect.objectContaining({
        uri: uriOf('eva00'),
        durationMs: expect.any(Number) as number,
      }),
    ])
  })

  it('logs a record deleted line only when a record was deleted', async () => {
    await harness.call(CREATE.nsid, asMember(PILOT), createBody())

    const missing = await harness.call(DELETE.nsid, asMember(PILOT), {
      boundary: HARNESS_ENGINEERING,
      repo: PILOT,
      collection: COLLECTION,
      rkey: 'eva-missing',
    })
    expect(missing.status).toBe(200)
    expect(logged('record deleted')).toEqual([])

    const deleted = await harness.call(DELETE.nsid, asMember(PILOT), {
      boundary: HARNESS_ENGINEERING,
      repo: PILOT,
      collection: COLLECTION,
      rkey: 'eva00',
    })
    expect(deleted.status).toBe(200)
    expect(logged('record deleted')).toEqual([
      expect.objectContaining({
        repo: PILOT,
        collection: COLLECTION,
        rkey: 'eva00',
        durationMs: expect.any(Number) as number,
      }),
    ])
  })

  it('logs one line with the count for a batch, not one per write', async () => {
    const response = await harness.call(APPLY_WRITES_NSID, asMember(PILOT), {
      boundary: HARNESS_ENGINEERING,
      repo: PILOT,
      writes: [
        createWrite('eva01', post('Sortie')),
        createWrite('eva02', post('Berserk')),
        createWrite('eva03', post('Rampage')),
      ],
    })

    expect(response.status).toBe(200)
    expect(logged('records applied')).toEqual([
      expect.objectContaining({
        count: 3,
        durationMs: expect.any(Number) as number,
      }),
    ])
    expect(logged('record created')).toEqual([])
  })

  it('never logs the record contents', async () => {
    await harness.call(CREATE.nsid, asMember(PILOT), createBody())

    expect(JSON.stringify(lines)).not.toContain('Sortie')
  })
})
