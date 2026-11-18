import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import postgres from 'postgres'
import {
  asMember,
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  startPostgresWriteHarness,
  startSqliteWriteHarness,
  withCredential,
  type WriteHarness,
} from './helpers/write-harness.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const PILOT = 'did:plc:rei-ayanami'
const COLLECTION = 'zone.stratos.feed.post'

function post(text: string, boundary = HARNESS_ENGINEERING) {
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

function defineSmokeScenarios(getHarness: () => WriteHarness) {
  it('serves the production handlers and validates the legacy createRecord output', async () => {
    const harness = getHarness()
    await harness.enrollMember(PILOT, [HARNESS_ENGINEERING])

    const created = await harness.call(
      'com.atproto.repo.createRecord',
      asMember(PILOT),
      {
        repo: PILOT,
        collection: COLLECTION,
        rkey: 'eva00',
        record: post('Sortie'),
      },
    )

    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({
      uri: `at://${PILOT}/${COLLECTION}/eva00`,
    })
    const rows = await harness.recordRows(`at://${PILOT}/${COLLECTION}/eva00`)
    expect(rows.boundaries).toEqual([HARNESS_ENGINEERING])
    expect(await harness.sequencedOps(PILOT)).toHaveLength(1)
  })

  it('refuses the next write once the member is held', async () => {
    const harness = getHarness()
    await harness.enrollMember(PILOT, [HARNESS_ENGINEERING])
    const write = (rkey: string) =>
      harness.call('com.atproto.repo.createRecord', asMember(PILOT), {
        repo: PILOT,
        collection: COLLECTION,
        rkey,
        record: post('Sortie'),
      })
    expect((await write('eva01')).status).toBe(200)

    await harness.holdMember(PILOT)
    const refused = await write('eva02')

    expect(refused.status).toBe(500)
    expect(refused.body).toEqual({
      error: 'InternalServerError',
      message: 'Internal Server Error',
    })
    expect(await harness.sequencedOps(PILOT)).toHaveLength(1)
  })

  it('refuses a write into a boundary removed from the member', async () => {
    const harness = getHarness()
    await harness.enrollMember(PILOT, [HARNESS_ENGINEERING, HARNESS_DESIGN])
    const write = (rkey: string) =>
      harness.call('com.atproto.repo.createRecord', asMember(PILOT), {
        repo: PILOT,
        collection: COLLECTION,
        rkey,
        record: post('Sortie', HARNESS_DESIGN),
      })
    expect((await write('eva03')).status).toBe(200)

    const removal = await harness.removeBoundary(PILOT, HARNESS_DESIGN)
    const refused = await write('eva04')

    expect(removal.status).toBe(200)
    expect(refused.status).toBe(400)
    expect(refused.body).toMatchObject({ error: 'ForbiddenBoundary' })
  })

  it('mints a space credential that the legacy write refuses', async () => {
    const harness = getHarness()
    await harness.enrollMember(PILOT, [HARNESS_ENGINEERING])
    const credential = await harness.mintSpaceCredential(
      PILOT,
      HARNESS_ENGINEERING,
    )

    const refused = await harness.call(
      'com.atproto.repo.createRecord',
      withCredential(credential),
      {
        repo: PILOT,
        collection: COLLECTION,
        rkey: 'eva05',
        record: post('Sortie'),
      },
    )

    expect(refused.status).toBe(401)
    expect(refused.body).toEqual({
      error: 'AuthenticationRequired',
      message: 'Authorization failed',
    })
  })
}

describe('write harness on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  defineSmokeScenarios(() => harness)
})

describe('write harness on postgres', () => {
  let connectionString: string
  let harness: WriteHarness

  beforeAll(async () => {
    connectionString = await startPostgresContainer()
  }, 120_000)

  afterAll(async () => {
    await stopPostgresContainer()
  })

  beforeEach(async () => {
    harness = await startPostgresWriteHarness(connectionString)
  }, 60_000)

  afterEach(async () => {
    await harness.close()
  })

  defineSmokeScenarios(() => harness)
})

describe('write harness connection release on postgres', () => {
  const CYCLES = 60
  const CONNECTION_TOLERANCE = 1
  let connectionString: string

  beforeAll(async () => {
    connectionString = await startPostgresContainer()
  }, 120_000)

  afterAll(async () => {
    await stopPostgresContainer()
  })

  async function openConnections(): Promise<number> {
    const probe = postgres(connectionString, { max: 1 })
    try {
      const [row] = await probe<
        { open: number }[]
      >`SELECT count(*)::int AS open FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`
      return row.open
    } finally {
      await probe.end()
    }
  }

  it('returns to the starting connection count after many start and stop cycles', async () => {
    const before = await openConnections()

    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const cycled = await startPostgresWriteHarness(connectionString)
      await cycled.enrollMember(PILOT, [HARNESS_ENGINEERING])
      await cycled.close()
    }

    const after = await openConnections()
    expect(Math.abs(after - before)).toBeLessThanOrEqual(CONNECTION_TOLERANCE)
  }, 600_000)
})
