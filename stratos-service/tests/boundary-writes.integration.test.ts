import { isDeepStrictEqual } from 'node:util'
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
import * as fc from 'fast-check'
import { jsonToLex } from '@atproto/lexicon'
import { parseCid } from '@northskysocial/stratos-core'
import {
  applyBoundaryWrites,
  assertBodyBoundaryMatches,
  assertRecordTypeMatches,
  type BoundaryWrite,
  deleteRecordInBoundary,
} from '../src/api/records/boundary-writes.js'
import { createRecord } from '../src/api/records/create.js'
import { deleteRecord } from '../src/api/records/delete.js'
import { RateLimitError } from '../src/shared/rate-limiter.js'
import {
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  HARNESS_LEADERSHIP,
  startPostgresWriteHarness,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const PILOT = 'did:plc:shinji-ikari'
const RIVAL = 'did:plc:asuka-langley'
const OUTSIDER = 'did:plc:gendo-ikari'
const COLLECTION = 'zone.stratos.feed.post'
const DOMAINS_TYPE = 'zone.stratos.boundary.defs#Domains'
const OTHER_SERVICE_BOUNDARY = 'did:web:seele.example/engineering'
const BLOB_CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'

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

function postWithBlob(text: string) {
  return {
    ...post(text),
    embed: {
      $type: 'app.bsky.embed.images',
      images: [
        {
          alt: 'Unit-01 berserk',
          image: jsonToLex({
            $type: 'blob',
            ref: { $link: BLOB_CID },
            mimeType: 'image/png',
            size: 1024,
          }),
        },
      ],
    },
  }
}

interface Refusal {
  error: string
  statusCode: number
}

/**
 * Domain errors such as PdsCustodyWriteForbidden carry a `code` and no status:
 * the handlers map them to 400 on the wire.
 */
async function refusalOf(work: Promise<unknown>): Promise<Refusal> {
  try {
    await work
  } catch (err) {
    const thrown = err as Partial<Refusal> & { code?: string }
    return {
      error: thrown.error ?? thrown.code ?? 'unnamed',
      statusCode: thrown.statusCode ?? 400,
    }
  }
  throw new Error('expected the write to be refused')
}

interface BoundaryRowEditor {
  replaceRecordBoundaries(
    uri: string,
    boundaries: readonly string[],
  ): Promise<void>
}

// The SQLite wrapper keeps its core transactor private; Postgres is the transactor itself.
function boundaryRowEditor(record: unknown): BoundaryRowEditor {
  const wrapped = record as { transactor?: BoundaryRowEditor }
  return wrapped.transactor ?? (record as BoundaryRowEditor)
}

type ScenarioGroup = 'rules' | 'deletes' | 'effects'
const SCENARIO_GROUPS: ScenarioGroup[] = ['rules', 'deletes', 'effects']

function defineBoundaryWriteScenarios(
  getHarness: () => WriteHarness,
  group: ScenarioGroup,
) {
  let harness: WriteHarness
  const describeIn = (
    owner: ScenarioGroup,
    name: string,
    body: () => void,
  ): void => {
    if (owner === group) describe(name, body)
  }
  let emit: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    harness = getHarness()
    await harness.enrollMember(PILOT, [HARNESS_ENGINEERING, HARNESS_DESIGN])
    await harness.enrollMember(RIVAL, [HARNESS_ENGINEERING])
    emit = vi.spyOn(harness.ctx.sequenceEvents, 'emit')
  })

  afterEach(() => {
    emit.mockRestore()
  })

  const writeEngineering = (writes: BoundaryWrite[], did = PILOT) =>
    applyBoundaryWrites(harness.ctx, did, HARNESS_ENGINEERING, writes)

  const deleteEngineering = (rkey: string, did = PILOT) =>
    deleteRecordInBoundary(
      harness.ctx,
      did,
      HARNESS_ENGINEERING,
      COLLECTION,
      rkey,
    )

  async function seed(rkey: string, boundary = HARNESS_ENGINEERING) {
    await createRecord(
      harness.ctx,
      {
        repo: PILOT,
        collection: COLLECTION,
        rkey,
        record: post(`seed ${rkey}`, claim(boundary)),
      },
      PILOT,
    )
    emit.mockClear()
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

  async function expectNothingChanged(
    before: Awaited<ReturnType<typeof snapshot>>,
    rkeys: string[],
  ) {
    expect(await snapshot(rkeys)).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  }

  describeIn('rules', 'body boundary agreement', () => {
    const BAD_CLAIMS: Array<[string, unknown]> = [
      ['another boundary', claim(HARNESS_DESIGN)],
      ['no values', { $type: DOMAINS_TYPE, values: [] }],
      [
        'two values',
        {
          $type: DOMAINS_TYPE,
          values: [{ value: HARNESS_ENGINEERING }, { value: HARNESS_DESIGN }],
        },
      ],
      [
        'the boundary twice',
        {
          $type: DOMAINS_TYPE,
          values: [
            { value: HARNESS_ENGINEERING },
            { value: HARNESS_ENGINEERING },
          ],
        },
      ],
      ['a string', HARNESS_ENGINEERING],
      ['null', null],
      ['values that are not a list', { values: HARNESS_ENGINEERING }],
      ['a value that is not a string', { values: [{ value: 7 }] }],
      [
        'an extra key beside the values',
        { ...claim(HARNESS_ENGINEERING), note: 'Sync ratio 400%' },
      ],
      ['an entry that is a string', { values: [HARNESS_ENGINEERING] }],
      ['an entry that is a number', { values: [7] }],
      ['an entry that is null', { values: [null] }],
      [
        'an entry with an extra key',
        { values: [{ value: HARNESS_ENGINEERING, note: 'Unit-01' }] },
      ],
      [
        'an entry with a type',
        { values: [{ $type: DOMAINS_TYPE, value: HARNESS_ENGINEERING }] },
      ],
      [
        'values that are an object holding the value',
        { values: { value: HARNESS_ENGINEERING } },
      ],
    ]

    const writeKinds: Array<[string, (claimed: unknown) => BoundaryWrite]> = [
      [
        'create',
        (claimed) => ({
          kind: 'create',
          collection: COLLECTION,
          rkey: 'eva00',
          record: post('Sortie', claimed),
        }),
      ],
      [
        'put',
        (claimed) => ({
          kind: 'put',
          collection: COLLECTION,
          rkey: 'eva00',
          record: post('Sortie', claimed),
        }),
      ],
      [
        'update',
        (claimed) => ({
          kind: 'update',
          collection: COLLECTION,
          rkey: 'eva00',
          record: post('Sortie', claimed),
        }),
      ],
    ]

    it.each(writeKinds)(
      'refuses a disagreeing claim on %s with BoundaryMismatch',
      async (_kind, build) => {
        await seed('eva00')
        const before = await snapshot(['eva00'])

        for (const [, claimed] of BAD_CLAIMS) {
          const refusal = await refusalOf(writeEngineering([build(claimed)]))
          expect(refusal.error).toBe('BoundaryMismatch')
          expect(refusal.statusCode).toBe(400)
        }

        await expectNothingChanged(before, ['eva00'])
      },
    )

    it('stores a record without a body boundary under the parameter boundary', async () => {
      const outcome = await writeEngineering([
        {
          kind: 'create',
          collection: COLLECTION,
          rkey: 'eva01',
          record: post('Sortie'),
        },
      ])

      expect(outcome.results).toHaveLength(1)
      expect(outcome.results[0].uri).toBe(uriOf('eva01'))
      const rows = await harness.recordRows(uriOf('eva01'))
      expect(rows.boundaries).toEqual([HARNESS_ENGINEERING])
      expect(rows.record?.value).not.toHaveProperty('boundary')
    })

    it.each([
      ['with a type', claim(HARNESS_ENGINEERING)],
      ['without a type', { values: [{ value: HARNESS_ENGINEERING }] }],
    ])('accepts the matching claim %s', async (_name, claimed) => {
      await writeEngineering([
        {
          kind: 'create',
          collection: COLLECTION,
          rkey: 'eva02',
          record: post('Sortie', claimed),
        },
      ])

      expect((await harness.recordRows(uriOf('eva02'))).boundaries).toEqual([
        HARNESS_ENGINEERING,
      ])
    })

    it('judges the record by the parameter boundary, not a claim', async () => {
      await expect(
        applyBoundaryWrites(harness.ctx, PILOT, HARNESS_DESIGN, [
          {
            kind: 'create',
            collection: COLLECTION,
            rkey: 'eva03',
            record: post('Sortie', claim(HARNESS_ENGINEERING)),
          },
        ]),
      ).rejects.toMatchObject({ customErrorName: 'BoundaryMismatch' })
      expect((await harness.recordRows(uriOf('eva03'))).record).toBeNull()
    })

    it('rejects a body that is not an object', async () => {
      const refusal = await refusalOf(
        writeEngineering([
          {
            kind: 'create',
            collection: COLLECTION,
            rkey: 'eva04',
            record: 'Sortie',
          },
        ]),
      )

      expect(refusal.statusCode).toBe(400)
      expect((await harness.recordRows(uriOf('eva04'))).record).toBeNull()
    })
  })

  describeIn('rules', 'the record type', () => {
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

    const kinds: Array<
      ['create' | 'put' | 'update', (record: unknown) => BoundaryWrite]
    > = [
      [
        'create',
        (record) => ({
          kind: 'create',
          collection: COLLECTION,
          rkey: 'eva00',
          record,
        }),
      ],
      [
        'put',
        (record) => ({
          kind: 'put',
          collection: COLLECTION,
          rkey: 'eva00',
          record,
        }),
      ],
      [
        'update',
        (record) => ({
          kind: 'update',
          collection: COLLECTION,
          rkey: 'eva00',
          record,
        }),
      ],
    ]

    describe.each(kinds)('on %s', (_kind, build) => {
      it.each(TYPE_FAULTS)(
        'refuses a record with %s with InvalidRecord before the lock',
        async (_fault, damage) => {
          await seed('eva00')
          const before = await snapshot(['eva00'])
          const acquire = vi.spyOn(harness.ctx.repoWriteLocks, 'acquire')
          try {
            const refusal = await refusalOf(
              writeEngineering([build(damage(post('Sortie')))]),
            )

            expect(refusal.error).toBe('InvalidRecord')
            expect(refusal.statusCode).toBe(400)
            expect(acquire).not.toHaveBeenCalled()
            await expectNothingChanged(before, ['eva00'])
          } finally {
            acquire.mockRestore()
          }
        },
      )
    })

    it('names the collection and the type found in the message', async () => {
      const thrown: unknown = await writeEngineering([
        {
          kind: 'create',
          collection: COLLECTION,
          rkey: 'eva00',
          record: { ...post('Sortie'), $type: 'app.bsky.feed.post' },
        },
      ]).catch((err: unknown) => err)

      expect((thrown as Error).message).toContain(COLLECTION)
      expect((thrown as Error).message).toContain('app.bsky.feed.post')
    })

    it('stores a record written without a body boundary that can be read back and deleted', async () => {
      await writeEngineering([
        {
          kind: 'create',
          collection: COLLECTION,
          rkey: 'eva00',
          record: post('Sortie'),
        },
      ])

      expect(
        (await harness.recordRows(uriOf('eva00'))).record?.value,
      ).toMatchObject({ $type: COLLECTION, text: 'Sortie' })
      expect(await deleteEngineering('eva00')).toMatchObject({ deleted: true })
      expect((await harness.recordRows(uriOf('eva00'))).record).toBeNull()
    })
  })

  describeIn('rules', 'createRecord rules', () => {
    it('stores the record, sequences a create scoped to the boundary and returns uri and cid', async () => {
      const rootBefore = await harness.repoRoot(PILOT)

      const outcome = await writeEngineering([
        {
          kind: 'create',
          collection: COLLECTION,
          rkey: 'eva00',
          record: post('Sortie'),
        },
      ])

      expect(outcome.results).toEqual([
        {
          uri: uriOf('eva00'),
          cid: expect.any(String),
          validationStatus: 'valid',
        },
      ])
      expect(outcome.commit.rev).toEqual(expect.any(String))
      expect((await harness.recordRows(uriOf('eva00'))).record?.cid).toBe(
        outcome.results[0].cid,
      )
      expect(await harness.repoRoot(PILOT)).not.toEqual(rootBefore)
      expect(await harness.repoRoot(PILOT)).toMatchObject({
        cid: outcome.commit.cid,
        rev: outcome.commit.rev,
      })
      expect(await harness.sequencedOps(PILOT)).toEqual([
        expect.objectContaining({
          action: 'create',
          path: `${COLLECTION}/eva00`,
          scope: [HARNESS_ENGINEERING],
          exclude: [],
        }),
      ])
      expect(emit).toHaveBeenCalledTimes(1)
      expect(emit).toHaveBeenCalledWith(PILOT)
    })

    it('gives a create without a key a fresh record key', async () => {
      const outcome = await writeEngineering([
        { kind: 'create', collection: COLLECTION, record: post('Sortie') },
        { kind: 'create', collection: COLLECTION, record: post('Standby') },
      ])

      const uris = outcome.results.map((result) => result.uri)
      expect(uris[0]).toMatch(
        new RegExp(`^at://${PILOT}/${COLLECTION}/[2-7a-z]{13}$`),
      )
      expect(new Set(uris).size).toBe(2)
      for (const uri of uris) {
        expect((await harness.recordRows(uri as string)).boundaries).toEqual([
          HARNESS_ENGINEERING,
        ])
      }
    })

    it.each([
      ['in the same boundary', () => seed('eva00')],
      ['in another boundary', () => seed('eva00', HARNESS_DESIGN)],
      [
        'that is taken down',
        async () => {
          await seed('eva00')
          await takeDown('eva00')
        },
      ],
    ])(
      'refuses a create on a key held %s with RecordAlreadyExists',
      async (_name, arrange) => {
        await arrange()
        const before = await snapshot(['eva00'])

        const refusal = await refusalOf(
          writeEngineering([
            {
              kind: 'create',
              collection: COLLECTION,
              rkey: 'eva00',
              record: post('Overwrite'),
            },
          ]),
        )

        expect(refusal.error).toBe('RecordAlreadyExists')
        expect(refusal.statusCode).toBe(400)
        await expectNothingChanged(before, ['eva00'])
      },
    )
  })

  describeIn('rules', 'putRecord rules', () => {
    it('creates when the key is absent, with a create op', async () => {
      const outcome = await writeEngineering([
        {
          kind: 'put',
          collection: COLLECTION,
          rkey: 'eva00',
          record: post('Sortie'),
        },
      ])

      expect(outcome.results[0].uri).toBe(uriOf('eva00'))
      expect((await harness.recordRows(uriOf('eva00'))).boundaries).toEqual([
        HARNESS_ENGINEERING,
      ])
      expect(await harness.sequencedOps(PILOT)).toEqual([
        expect.objectContaining({
          action: 'create',
          scope: [HARNESS_ENGINEERING],
        }),
      ])
    })

    it('updates a record held in the boundary, with an update op and no removal', async () => {
      await seed('eva00')
      const cidBefore = (await harness.recordRows(uriOf('eva00'))).record?.cid

      const outcome = await writeEngineering([
        {
          kind: 'put',
          collection: COLLECTION,
          rkey: 'eva00',
          record: post('Berserk'),
        },
      ])

      const rows = await harness.recordRows(uriOf('eva00'))
      expect(rows.record?.cid).toBe(outcome.results[0].cid)
      expect(rows.record?.cid).not.toBe(cidBefore)
      expect(rows.record?.value).toMatchObject({ text: 'Berserk' })
      expect(rows.boundaries).toEqual([HARNESS_ENGINEERING])
      const actions = (await harness.sequencedOps(PILOT)).map((op) => op.action)
      expect(actions).toEqual(['create', 'update'])
    })

    it.each([
      ['in another boundary', () => seed('eva00', HARNESS_DESIGN)],
      [
        'that is taken down',
        async () => {
          await seed('eva00')
          await takeDown('eva00')
        },
      ],
    ])(
      'refuses a put on a key held %s with RecordAlreadyExists',
      async (_name, arrange) => {
        await arrange()
        const before = await snapshot(['eva00'])

        const refusal = await refusalOf(
          writeEngineering([
            {
              kind: 'put',
              collection: COLLECTION,
              rkey: 'eva00',
              record: post('Overwrite'),
            },
          ]),
        )

        expect(refusal.error).toBe('RecordAlreadyExists')
        await expectNothingChanged(before, ['eva00'])
      },
    )
  })

  describeIn('rules', 'update rules', () => {
    it('updates a record held in the boundary', async () => {
      await seed('eva00')

      await writeEngineering([
        {
          kind: 'update',
          collection: COLLECTION,
          rkey: 'eva00',
          record: post('Berserk'),
        },
      ])

      expect(
        (await harness.recordRows(uriOf('eva00'))).record?.value,
      ).toMatchObject({ text: 'Berserk' })
      expect(
        (await harness.sequencedOps(PILOT)).map((op) => op.action),
      ).toEqual(['create', 'update'])
    })

    it.each([
      ['missing', async () => {}],
      ['held in another boundary', () => seed('eva00', HARNESS_DESIGN)],
      [
        'taken down',
        async () => {
          await seed('eva00')
          await takeDown('eva00')
        },
      ],
    ])(
      'refuses an update of a record that is %s with RecordNotFound',
      async (_name, arrange) => {
        await arrange()
        const before = await snapshot(['eva00'])

        const refusal = await refusalOf(
          writeEngineering([
            {
              kind: 'update',
              collection: COLLECTION,
              rkey: 'eva00',
              record: post('Berserk'),
            },
          ]),
        )

        expect(refusal.error).toBe('RecordNotFound')
        expect(refusal.statusCode).toBe(400)
        await expectNothingChanged(before, ['eva00'])
      },
    )
  })

  describeIn('deletes', 'delete inside a batch', () => {
    it('deletes a record held in the boundary with one scoped delete', async () => {
      await seed('eva00')

      const outcome = await writeEngineering([
        { kind: 'delete', collection: COLLECTION, rkey: 'eva00' },
      ])

      expect(outcome.results).toEqual([{}])
      const rows = await harness.recordRows(uriOf('eva00'))
      expect(rows.record).toBeNull()
      expect(rows.boundaries).toEqual([])
      const ops = (await harness.sequencedOps(PILOT)).slice(1)
      expect(ops.map(({ action, scope }) => ({ action, scope }))).toEqual([
        { action: 'delete', scope: [HARNESS_ENGINEERING] },
      ])
    })

    it('deletes a taken-down record', async () => {
      await seed('eva00')
      await takeDown('eva00')

      await writeEngineering([
        { kind: 'delete', collection: COLLECTION, rkey: 'eva00' },
      ])

      expect((await harness.recordRows(uriOf('eva00'))).record).toBeNull()
    })

    it.each([
      ['missing', async () => {}],
      ['held in another boundary', () => seed('eva00', HARNESS_DESIGN)],
    ])(
      'refuses a delete of a record that is %s with RecordNotFound',
      async (_name, arrange) => {
        await arrange()
        const before = await snapshot(['eva00'])

        const refusal = await refusalOf(
          writeEngineering([
            { kind: 'delete', collection: COLLECTION, rkey: 'eva00' },
          ]),
        )

        expect(refusal.error).toBe('RecordNotFound')
        await expectNothingChanged(before, ['eva00'])
      },
    )
  })

  describeIn('deletes', 'deleteRecordInBoundary', () => {
    it('deletes a record held in the boundary and reports the commit', async () => {
      await seed('eva00')
      const rootBefore = await harness.repoRoot(PILOT)

      const outcome = await deleteEngineering('eva00')

      expect(outcome).toEqual({
        deleted: true,
        commit: { cid: expect.any(String), rev: expect.any(String) },
      })
      expect((await harness.recordRows(uriOf('eva00'))).record).toBeNull()
      expect(await harness.repoRoot(PILOT)).not.toEqual(rootBefore)
      expect(emit).toHaveBeenCalledTimes(1)
    })

    it('deletes a taken-down record', async () => {
      await seed('eva00')
      await takeDown('eva00')

      expect(await deleteEngineering('eva00')).toMatchObject({ deleted: true })
      expect((await harness.recordRows(uriOf('eva00'))).record).toBeNull()
    })

    it('answers the same for a missing record and one held in another boundary, and changes nothing', async () => {
      await seed('eva00', HARNESS_DESIGN)
      const before = await snapshot(['eva00', 'eva-missing'])

      const otherBoundary = await deleteEngineering('eva00')
      const missing = await deleteEngineering('eva-missing')

      expect(otherBoundary).toEqual({ deleted: false })
      expect(JSON.stringify(otherBoundary)).toBe(JSON.stringify(missing))
      await expectNothingChanged(before, ['eva00', 'eva-missing'])
    })

    it('leaves a record held in another boundary untouched by name', async () => {
      await seed('eva00', HARNESS_DESIGN)

      await deleteEngineering('eva00')

      const rows = await harness.recordRows(uriOf('eva00'))
      expect(rows.record).not.toBeNull()
      expect(rows.boundaries).toEqual([HARNESS_DESIGN])
    })
  })

  describeIn(
    'deletes',
    'a record stored in other than exactly one boundary',
    () => {
      async function seedRows(rkey: string, rows: string[]) {
        await seed(rkey)
        await harness.ctx.actorStore.transact(PILOT, (store) =>
          boundaryRowEditor(store.record).replaceRecordBoundaries(
            uriOf(rkey),
            rows,
          ),
        )
        emit.mockClear()
      }

      // The store returns rows in name order, so the two positions the boundary
      // can take are told apart by what the other row sorts before or after.
      const rowSets: Array<[string, string[]]> = [
        [
          'the boundary sorting first',
          [HARNESS_ENGINEERING, HARNESS_LEADERSHIP],
        ],
        ['the boundary sorting last', [HARNESS_DESIGN, HARNESS_ENGINEERING]],
        ['no rows', []],
      ]

      describe.each(rowSets)('with rows %s', (_name, rows) => {
        const single = (kind: 'put' | 'update'): BoundaryWrite => ({
          kind,
          collection: COLLECTION,
          rkey: 'eva00',
          record: post('Berserk'),
        })

        // The write starts after the snapshot, so its refusal is never
        // without a handler and the snapshot is of the state before it.
        async function expectRefusedUnchanged(
          work: () => Promise<unknown>,
          error: string,
        ) {
          const before = await snapshot(['eva00'])
          expect((await refusalOf(work())).error).toBe(error)
          await expectNothingChanged(before, ['eva00'])
          const after = await harness.recordRows(uriOf('eva00'))
          expect(after.record).not.toBeNull()
          expect([...after.boundaries].sort()).toEqual([...rows].sort())
        }

        it('refuses a put with RecordAlreadyExists', async () => {
          await seedRows('eva00', rows)
          await expectRefusedUnchanged(
            () => writeEngineering([single('put')]),
            'RecordAlreadyExists',
          )
        })

        it('refuses an update with RecordNotFound', async () => {
          await seedRows('eva00', rows)
          await expectRefusedUnchanged(
            () => writeEngineering([single('update')]),
            'RecordNotFound',
          )
        })

        it('refuses a delete inside a batch with RecordNotFound', async () => {
          await seedRows('eva00', rows)
          await expectRefusedUnchanged(
            () =>
              writeEngineering([
                { kind: 'delete', collection: COLLECTION, rkey: 'eva00' },
              ]),
            'RecordNotFound',
          )
        })

        it('reports a single delete as not deleted and changes nothing', async () => {
          await seedRows('eva00', rows)
          const before = await snapshot(['eva00'])

          expect(await deleteEngineering('eva00')).toEqual({ deleted: false })

          await expectNothingChanged(before, ['eva00'])
          const after = await harness.recordRows(uriOf('eva00'))
          expect(after.record).not.toBeNull()
          expect([...after.boundaries].sort()).toEqual([...rows].sort())
          const removals = (await harness.sequencedOps(PILOT)).filter(
            (op) => op.action === 'delete',
          )
          expect(removals).toEqual([])
        })
      })
    },
  )

  describeIn('deletes', 'a delete that finds nothing', () => {
    function recordReadsInTransactions(): {
      calls: string[]
      stop: () => void
    } {
      const calls: string[] = []
      const actorStore = harness.ctx.actorStore
      const realTransact = actorStore.transact.bind(actorStore)
      const transactSpy = vi
        .spyOn(actorStore, 'transact')
        .mockImplementation((did, fn) =>
          realTransact(did, (store) => {
            const realGetRecord = store.record.getRecord.bind(store.record)
            vi.spyOn(store.record, 'getRecord').mockImplementation(
              (...args) => {
                calls.push('getRecord')
                return realGetRecord(...args)
              },
            )
            const realGetBoundaries = store.record.getRecordBoundaries.bind(
              store.record,
            )
            vi.spyOn(store.record, 'getRecordBoundaries').mockImplementation(
              (...args) => {
                calls.push('getRecordBoundaries')
                return realGetBoundaries(...args)
              },
            )
            return fn(store)
          }),
        )
      return { calls, stop: () => transactSpy.mockRestore() }
    }

    it('issues the same record reads for a missing record and one held in another boundary', async () => {
      await seed('eva00', HARNESS_DESIGN)

      const missing = recordReadsInTransactions()
      try {
        await deleteEngineering('eva-missing')
      } finally {
        missing.stop()
      }
      const otherBoundary = recordReadsInTransactions()
      try {
        await deleteEngineering('eva00')
      } finally {
        otherBoundary.stop()
      }

      expect(missing.calls).toEqual(['getRecord', 'getRecordBoundaries'])
      expect(otherBoundary.calls).toEqual(missing.calls)
    })
  })

  describeIn('deletes', 'an empty list of writes', () => {
    it('refuses with InvalidRequest and charges and stores nothing', async () => {
      const charge = vi.spyOn(
        harness.ctx.writeRateLimiter,
        'assertWriteAllowed',
      )
      const acquire = vi.spyOn(harness.ctx.repoWriteLocks, 'acquire')
      try {
        const before = await snapshot([])

        const refusal = await refusalOf(writeEngineering([]))

        expect(refusal.error).toBe('InvalidRequest')
        expect(refusal.statusCode).toBe(400)
        expect(charge).not.toHaveBeenCalled()
        expect(acquire).not.toHaveBeenCalled()
        await expectNothingChanged(before, [])
      } finally {
        charge.mockRestore()
        acquire.mockRestore()
      }
    })
  })

  describeIn('deletes', 'atomicity and duplicate keys', () => {
    it.each([
      [
        'an update of a missing record',
        {
          kind: 'update',
          collection: COLLECTION,
          rkey: 'eva-missing',
          record: post('Berserk'),
        } satisfies BoundaryWrite,
        'RecordNotFound',
      ],
      [
        'a create on a taken key',
        {
          kind: 'create',
          collection: COLLECTION,
          rkey: 'eva-taken',
          record: post('Berserk'),
        } satisfies BoundaryWrite,
        'RecordAlreadyExists',
      ],
    ])(
      'stores nothing when a later write is %s',
      async (_name, failing, error) => {
        await seed('eva-taken')
        const before = await snapshot(['eva-new', 'eva-taken', 'eva-missing'])

        const refusal = await refusalOf(
          writeEngineering([
            {
              kind: 'create',
              collection: COLLECTION,
              rkey: 'eva-new',
              record: post('Sortie'),
            },
            failing,
          ]),
        )

        expect(refusal.error).toBe(error)
        await expectNothingChanged(before, [
          'eva-new',
          'eva-taken',
          'eva-missing',
        ])
      },
    )

    it('commits every write of a batch in one commit', async () => {
      await seed('eva-old')

      const outcome = await writeEngineering([
        {
          kind: 'create',
          collection: COLLECTION,
          rkey: 'eva-new',
          record: post('Sortie'),
        },
        {
          kind: 'update',
          collection: COLLECTION,
          rkey: 'eva-old',
          record: post('Berserk'),
        },
      ])

      expect(outcome.results).toHaveLength(2)
      expect(await harness.repoRoot(PILOT)).toMatchObject(outcome.commit)
      expect(emit).toHaveBeenCalledTimes(1)
    })

    it.each([
      [
        'a create and a delete of one key',
        [
          {
            kind: 'create',
            collection: COLLECTION,
            rkey: 'eva00',
            record: post('a'),
          },
          { kind: 'delete', collection: COLLECTION, rkey: 'eva00' },
        ] satisfies BoundaryWrite[],
      ],
      [
        'two creates of one key',
        [
          {
            kind: 'create',
            collection: COLLECTION,
            rkey: 'eva00',
            record: post('a'),
          },
          {
            kind: 'create',
            collection: COLLECTION,
            rkey: 'eva00',
            record: post('b'),
          },
        ] satisfies BoundaryWrite[],
      ],
      [
        'an update and a put of one key',
        [
          {
            kind: 'update',
            collection: COLLECTION,
            rkey: 'eva00',
            record: post('a'),
          },
          {
            kind: 'put',
            collection: COLLECTION,
            rkey: 'eva00',
            record: post('b'),
          },
        ] satisfies BoundaryWrite[],
      ],
    ])(
      'refuses %s with InvalidRequest before taking the lock',
      async (_name, writes) => {
        const acquire = vi.spyOn(harness.ctx.repoWriteLocks, 'acquire')
        try {
          const before = await snapshot(['eva00'])

          const refusal = await refusalOf(writeEngineering(writes))

          expect(refusal.error).toBe('InvalidRequest')
          expect(refusal.statusCode).toBe(400)
          expect(acquire).not.toHaveBeenCalled()
          await expectNothingChanged(before, ['eva00'])
        } finally {
          acquire.mockRestore()
        }
      },
    )
  })

  describeIn('deletes', 'checks before the lock', () => {
    it('charges the rate limiter one unit per write, before any validation', async () => {
      const charge = vi.spyOn(
        harness.ctx.writeRateLimiter,
        'assertWriteAllowed',
      )
      try {
        await refusalOf(
          writeEngineering([
            {
              kind: 'create',
              collection: 'app.bsky.feed.post',
              record: post('a'),
            },
            {
              kind: 'create',
              collection: 'app.bsky.feed.post',
              record: post('b'),
            },
            { kind: 'delete', collection: COLLECTION, rkey: 'eva00' },
          ]),
        )
        expect(charge).toHaveBeenCalledWith(PILOT, 3)

        charge.mockClear()
        await deleteEngineering('eva-missing')
        expect(charge).toHaveBeenCalledWith(PILOT, 1)
      } finally {
        charge.mockRestore()
      }
    })

    it('refuses a batch over the rate limit with nothing stored', async () => {
      const writes: BoundaryWrite[] = Array.from({ length: 301 }, () => ({
        kind: 'create',
        collection: COLLECTION,
        record: post('Sortie'),
      }))
      const before = await snapshot([])

      await expect(writeEngineering(writes)).rejects.toBeInstanceOf(
        RateLimitError,
      )

      await expectNothingChanged(before, [])
    })

    it('refuses a collection the hosted space type does not allow', async () => {
      const before = await snapshot(['eva00'])

      const refusal = await refusalOf(
        writeEngineering([
          {
            kind: 'create',
            collection: 'app.bsky.feed.post',
            rkey: 'eva00',
            record: post('Sortie'),
          },
        ]),
      )

      expect(refusal.error).toBe('InvalidCollection')
      await expectNothingChanged(before, ['eva00'])
    })

    const refusedWriters: Array<[string, () => Promise<unknown>, string]> = [
      [
        'a caller who is not enrolled',
        () =>
          writeEngineering(
            [{ kind: 'delete', collection: COLLECTION, rkey: 'a' }],
            OUTSIDER,
          ),
        'NotEnrolled',
      ],
      [
        'a service identity',
        async () => {
          await harness.enrollServiceIdentity('did:web:magi.nerv.tokyo.jp', [
            HARNESS_ENGINEERING,
          ])
          return writeEngineering(
            [{ kind: 'create', collection: COLLECTION, record: post('a') }],
            'did:web:magi.nerv.tokyo.jp',
          )
        },
        'ServiceWriteForbidden',
      ],
      [
        'a pds custody member',
        async () => {
          await harness.enrollPdsCustodyMember('did:plc:misato-katsuragi', [
            HARNESS_ENGINEERING,
          ])
          return writeEngineering(
            [{ kind: 'create', collection: COLLECTION, record: post('a') }],
            'did:plc:misato-katsuragi',
          )
        },
        'PdsCustodyWriteForbidden',
      ],
      [
        'a boundary of another service',
        () =>
          applyBoundaryWrites(harness.ctx, PILOT, OTHER_SERVICE_BOUNDARY, [
            { kind: 'create', collection: COLLECTION, record: post('a') },
          ]),
        'ServiceMismatch',
      ],
      [
        'a malformed boundary name',
        () =>
          applyBoundaryWrites(harness.ctx, PILOT, 'Not A Skey!', [
            { kind: 'create', collection: COLLECTION, record: post('a') },
          ]),
        'InvalidDomain',
      ],
      [
        'a boundary the caller does not hold',
        () =>
          applyBoundaryWrites(harness.ctx, PILOT, HARNESS_LEADERSHIP, [
            { kind: 'create', collection: COLLECTION, record: post('a') },
          ]),
        'ForbiddenBoundary',
      ],
      [
        'a single delete in a boundary the caller does not hold',
        () =>
          deleteRecordInBoundary(
            harness.ctx,
            PILOT,
            HARNESS_LEADERSHIP,
            COLLECTION,
            'eva00',
          ),
        'ForbiddenBoundary',
      ],
      [
        'a single delete by a service identity',
        async () => {
          await harness.enrollServiceIdentity('did:web:casper.nerv.tokyo.jp', [
            HARNESS_ENGINEERING,
          ])
          return deleteEngineering('eva00', 'did:web:casper.nerv.tokyo.jp')
        },
        'ServiceWriteForbidden',
      ],
    ]

    it.each(refusedWriters)(
      'refuses %s with %s',
      async (_name, attempt, error) => {
        const refusal = await refusalOf(attempt())

        expect(refusal.error).toBe(error)
        expect(refusal.statusCode).toBe(400)
        expect(emit).not.toHaveBeenCalled()
      },
    )
  })

  describeIn('effects', 'blob associations', () => {
    const associated = () =>
      harness.ctx.actorStore.read(PILOT, (store) =>
        store.blob.getRecordsForBlob(parseCid(BLOB_CID)),
      )

    it('associates the blobs of a created record', async () => {
      await writeEngineering([
        {
          kind: 'create',
          collection: COLLECTION,
          rkey: 'eva00',
          record: postWithBlob('Sortie'),
        },
      ])

      expect(await associated()).toEqual([uriOf('eva00')])
    })

    it('drops the association when an update removes the blob', async () => {
      await writeEngineering([
        {
          kind: 'create',
          collection: COLLECTION,
          rkey: 'eva00',
          record: postWithBlob('Sortie'),
        },
      ])

      await writeEngineering([
        {
          kind: 'update',
          collection: COLLECTION,
          rkey: 'eva00',
          record: post('Berserk'),
        },
      ])

      expect(await associated()).toEqual([])
    })

    it('drops the association when the record is deleted', async () => {
      await writeEngineering([
        {
          kind: 'create',
          collection: COLLECTION,
          rkey: 'eva00',
          record: postWithBlob('Sortie'),
        },
      ])

      await deleteEngineering('eva00')

      expect(await associated()).toEqual([])
    })
  })

  describeIn('effects', 'events match the legacy write path', () => {
    const shapeOf = async (did: string) =>
      (await harness.sequencedOps(did)).map(({ action, scope, exclude }) => ({
        action,
        scope,
        exclude,
      }))

    it('sequences a create like the legacy create', async () => {
      await createRecord(
        harness.ctx,
        {
          repo: RIVAL,
          collection: COLLECTION,
          rkey: 'eva00',
          record: post('Sortie', claim(HARNESS_ENGINEERING)),
        },
        RIVAL,
      )

      await writeEngineering([
        {
          kind: 'create',
          collection: COLLECTION,
          rkey: 'eva00',
          record: post('Sortie'),
        },
      ])

      expect(await shapeOf(PILOT)).toEqual(await shapeOf(RIVAL))
    })

    // The legacy delete also sequences a delete with no boundary, which no
    // reader delivers.
    it('sequences a delete like the legacy delete, less its unscoped delete', async () => {
      await createRecord(
        harness.ctx,
        {
          repo: RIVAL,
          collection: COLLECTION,
          rkey: 'eva00',
          record: post('Sortie', claim(HARNESS_ENGINEERING)),
        },
        RIVAL,
      )
      await seed('eva00')
      await deleteRecord(
        harness.ctx,
        { repo: RIVAL, collection: COLLECTION, rkey: 'eva00' },
        RIVAL,
      )

      await deleteEngineering('eva00')

      const legacy = await shapeOf(RIVAL)
      expect(legacy.filter((op) => op.scope.length === 0)).toHaveLength(1)
      expect(await shapeOf(PILOT)).toEqual(
        legacy.filter((op) => op.scope.length > 0),
      )
    })
  })

  describeIn(
    'effects',
    'a change that lands between the checks and the lock',
    () => {
      function mutateBeforeNextAcquire(mutate: () => Promise<void>) {
        const locks = harness.ctx.repoWriteLocks
        const realAcquire = locks.acquire.bind(locks)
        let armed = true
        return vi.spyOn(locks, 'acquire').mockImplementation(async (did) => {
          if (armed) {
            armed = false
            await mutate()
          }
          return realAcquire(did)
        })
      }

      const mutations: Array<[string, string, () => Promise<unknown>]> = [
        ['an operator hold', 'NotEnrolled', () => harness.holdMember(PILOT)],
        [
          'a boundary removal',
          'ForbiddenBoundary',
          async () => {
            expect(
              (await harness.removeBoundary(PILOT, HARNESS_ENGINEERING)).status,
            ).toBe(200)
          },
        ],
      ]

      describe.each(mutations)('%s', (_name, error, mutate) => {
        it('refuses a batch and stores nothing', async () => {
          const before = await snapshot(['eva00'])
          const acquire = mutateBeforeNextAcquire(async () => {
            await mutate()
          })

          try {
            await expect(
              writeEngineering([
                {
                  kind: 'create',
                  collection: COLLECTION,
                  rkey: 'eva00',
                  record: post('Sortie'),
                },
              ]),
            ).rejects.toMatchObject({ customErrorName: error })
          } finally {
            acquire.mockRestore()
          }

          await expectNothingChanged(before, ['eva00'])
        })

        it('refuses a single delete and leaves the record', async () => {
          await seed('eva00')
          const before = await snapshot(['eva00'])
          const acquire = mutateBeforeNextAcquire(async () => {
            await mutate()
          })

          try {
            await expect(deleteEngineering('eva00')).rejects.toMatchObject({
              customErrorName: error,
            })
          } finally {
            acquire.mockRestore()
          }

          await expectNothingChanged(before, ['eva00'])
        })
      })
    },
  )
}

describe('assertBodyBoundaryMatches', () => {
  const BOUNDARY = HARNESS_ENGINEERING
  const canonicalClaims = [
    { values: [{ value: BOUNDARY }] },
    { $type: DOMAINS_TYPE, values: [{ value: BOUNDARY }] },
  ]

  const claimEntry = fc.oneof(
    fc.record({ value: fc.constantFrom(BOUNDARY, HARNESS_DESIGN, '') }),
    fc.record(
      {
        value: fc.constantFrom(BOUNDARY, HARNESS_DESIGN),
        $type: fc.constantFrom(DOMAINS_TYPE, 'zone.stratos.other'),
        note: fc.string(),
      },
      { requiredKeys: ['value'] },
    ),
    fc.oneof(fc.constantFrom(BOUNDARY, ''), fc.integer(), fc.constant(null)),
  )

  const claimLike = fc.oneof(
    fc.jsonValue(),
    fc.constantFrom(...canonicalClaims),
    fc.record(
      {
        $type: fc.constantFrom(DOMAINS_TYPE, 'zone.stratos.other', 7),
        values: fc.oneof(
          fc.array(claimEntry, { maxLength: 3 }),
          fc.record({ value: fc.constant(BOUNDARY) }),
          fc.constant(BOUNDARY),
        ),
        note: fc.string(),
      },
      { requiredKeys: ['values'] },
    ),
  )

  it('accepts exactly an absent claim or the single matching value', () => {
    fc.assert(
      fc.property(claimLike, (claimed) => {
        const plainClaim: unknown = JSON.parse(JSON.stringify(claimed))
        const agrees = canonicalClaims.some((canonical) =>
          isDeepStrictEqual(canonical, plainClaim),
        )
        const check = () =>
          assertBodyBoundaryMatches({ boundary: claimed }, BOUNDARY)
        if (agrees) {
          expect(check).not.toThrow()
        } else {
          expect(check).toThrowError(
            expect.objectContaining({ customErrorName: 'BoundaryMismatch' }),
          )
        }
      }),
      { numRuns: 500 },
    )
  })

  it('accepts a record with no boundary property whatever else it holds', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string().filter((key) => key !== 'boundary'),
          fc.jsonValue(),
        ),
        (rest) => {
          expect(() => assertBodyBoundaryMatches(rest, BOUNDARY)).not.toThrow()
        },
      ),
    )
  })
})

describe('assertRecordTypeMatches', () => {
  it('accepts exactly a record whose type is its collection', () => {
    fc.assert(
      fc.property(
        fc.record(
          { $type: fc.oneof(fc.constant(COLLECTION), fc.jsonValue()) },
          { requiredKeys: [] },
        ),
        (record) => {
          const check = () => assertRecordTypeMatches(record, COLLECTION)
          if (record.$type === COLLECTION) {
            expect(check).not.toThrow()
          } else {
            expect(check).toThrowError(
              expect.objectContaining({ customErrorName: 'InvalidRecord' }),
            )
          }
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe.each(SCENARIO_GROUPS)('boundary writes on sqlite: %s', (group) => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  defineBoundaryWriteScenarios(() => harness, group)
})

// The groups split the scenarios for readable reports; they share one container.
let postgresConnection: Promise<string> | undefined
const LAST_SCENARIO_GROUP = SCENARIO_GROUPS[SCENARIO_GROUPS.length - 1]

describe.each(SCENARIO_GROUPS)('boundary writes on postgres: %s', (group) => {
  let connectionString: string
  let harness: WriteHarness

  beforeAll(async () => {
    postgresConnection ??= startPostgresContainer()
    connectionString = await postgresConnection
  }, 120_000)

  afterAll(async () => {
    if (group === LAST_SCENARIO_GROUP) await stopPostgresContainer()
  }, 60_000)

  beforeEach(async () => {
    harness = await startPostgresWriteHarness(connectionString)
  }, 60_000)

  afterEach(async () => {
    await harness.close()
  })

  defineBoundaryWriteScenarios(() => harness, group)
})
