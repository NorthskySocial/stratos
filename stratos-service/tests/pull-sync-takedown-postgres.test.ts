/**
 * Takedown filter for listRepoOps, getTakedownStates and latestTakedowns
 * against the Postgres stores. Mirrors the SQLite cases in pull-sync.integration.test.ts and
 * stratos-core/tests/record.test.ts.
 *
 * Requires Docker; starts its own PostgreSQL container.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  buildCommit,
  computeCid,
  encodeRecord,
  parseCid,
} from '@northskysocial/stratos-core'
import { P256Keypair } from '@atproto/crypto'

import type { ActorStore } from '../src/actor-store-types.js'
import type { AppContext } from '../src/context.js'
import {
  closeServicePgDb,
  createServicePgDb,
  migrateServicePgDb,
  type ServicePgDb,
} from '../src/db/pg.js'
import { PgLabelStore } from '../src/features/moderation/index.js'
import { listRepoOps } from '../src/features/pull-sync/index.js'
import {
  StratosBlockStoreReader,
  signAndPersistCommit,
} from '../src/features/index.js'
import { PostgresActorStore } from '../src/infra/storage/postgres/index.js'
import {
  cborToRecord,
  createCid,
  createMockBlobStoreCreator,
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const POST = 'zone.stratos.feed.post'
const REV = { r1: '3aaaa000000t1', r2: '3bbbb000000t2' }
const NERV: ReadonlySet<string> = new Set(['nerv'])

describe('listRepoOps takedown filter (Postgres)', () => {
  let actorStore: ActorStore
  let ctx: AppContext
  let serviceDb: ServicePgDb
  let labelStore: PgLabelStore
  let repoDid: string
  let didCounter = 0

  const uriOf = (rkey: string) => `at://${repoDid}/${POST}/${rkey}`

  beforeAll(async () => {
    const pgUrl = await startPostgresContainer()
    actorStore = new PostgresActorStore({
      connectionString: pgUrl,
      blobstore: createMockBlobStoreCreator(),
      cborToRecord,
    })
    serviceDb = createServicePgDb(pgUrl)
    await migrateServicePgDb(serviceDb)
    labelStore = new PgLabelStore(serviceDb)
    ctx = { actorStore, labelStore } as unknown as AppContext
  }, 120_000)

  afterAll(async () => {
    await closeServicePgDb(serviceDb)
    await stopPostgresContainer()
  }, 60_000)

  beforeEach(async () => {
    repoDid = `did:plc:pgtakedown${didCounter++}`
    await actorStore.create(repoDid)
  })

  async function appendEvent(
    rev: string,
    ops: Array<{ rkey: string; cid: string }>,
  ) {
    await actorStore.transact(repoDid, async (store) => {
      await store.sequence.appendEvent({
        did: repoDid,
        eventType: 'append',
        event: Buffer.from(
          encodeRecord({
            rev,
            ops: ops.map(({ rkey, cid }) => ({
              action: 'create',
              path: `${POST}/${rkey}`,
              cid,
              record: {
                text: 'hello',
                boundary: { values: [{ value: 'nerv' }] },
              },
            })),
          }),
        ),
        invalidated: 0,
        sequencedAt: new Date().toISOString(),
      })
    })
  }

  async function indexPost(rkey: string) {
    await actorStore.transact(repoDid, async (store) => {
      await store.record.indexRecord(
        uriOf(rkey),
        await createCid(`record ${rkey}`),
        { text: rkey },
        'create',
        'rev1',
      )
    })
  }

  const setTakedown = (rkey: string, applied: boolean) =>
    actorStore.transact(repoDid, async (store) => {
      await store.record.updateRecordTakedown(
        uriOf(rkey),
        applied ? { applied, ref: `TD-${rkey}` } : { applied },
      )
    })

  async function commitPosts(rkeys: string[]) {
    const keypair = await P256Keypair.create({ exportable: true })
    await actorStore.transact(repoDid, async (store) => {
      const record = { text: 'commit', boundary: { values: [] } }
      const recordCid = await computeCid(record)
      const unsigned = await buildCommit(
        new StratosBlockStoreReader(store.repo),
        null,
        {
          did: repoDid,
          writes: rkeys.map((rkey) => ({
            action: 'create' as const,
            collection: POST,
            rkey,
            cid: parseCid(recordCid).toString(),
          })),
        },
      )
      await store.repo.putBlock(recordCid, encodeRecord(record), unsigned.rev)
      await signAndPersistCommit(
        store.repo,
        (bytes: Uint8Array) => keypair.sign(bytes),
        unsigned,
      )
    })
  }

  const list = (excludeValues: boolean) =>
    listRepoOps(ctx, { did: repoDid, limit: 100, excludeValues }, NERV)

  it('omits a taken-down record and keeps the head commit unchanged (o1)', async () => {
    await commitPosts(['ayanami', 'soryu'])
    await appendEvent(REV.r1, [{ rkey: 'ayanami', cid: 'cidA' }])
    await appendEvent(REV.r2, [{ rkey: 'soryu', cid: 'cidB' }])
    await indexPost('ayanami')
    await indexPost('soryu')
    const commitBefore = (await list(false)).commit
    expect(commitBefore).toBeDefined()

    await setTakedown('ayanami', true)

    for (const excludeValues of [false, true]) {
      const res = await list(excludeValues)
      expect(res.ops.map((op) => op.rkey)).toEqual(['soryu'])
      expect(res.ops[0].value === undefined).toBe(excludeValues)
      expect(res.commit).toEqual(commitBefore)
    }
  })

  it('still returns the other op of a batch event (o2)', async () => {
    await appendEvent(REV.r1, [
      { rkey: 'ayanami', cid: 'cidA' },
      { rkey: 'soryu', cid: 'cidB' },
    ])
    await indexPost('ayanami')
    await indexPost('soryu')
    await setTakedown('ayanami', true)

    const res = await list(false)

    expect(res.ops.map((op) => [op.rev, op.rkey, op.cid])).toEqual([
      [REV.r1, 'soryu', 'cidB'],
    ])
  })

  async function appendDelete(rev: string, rkey: string) {
    await actorStore.transact(repoDid, async (store) => {
      await store.sequence.appendEvent({
        did: repoDid,
        eventType: 'append',
        event: Buffer.from(
          encodeRecord({
            rev,
            ops: [
              {
                action: 'delete',
                path: `${POST}/${rkey}`,
                boundary: { values: [{ value: 'nerv' }] },
              },
            ],
          }),
        ),
        invalidated: 0,
        sequencedAt: new Date().toISOString(),
      })
    })
  }

  async function appendLabel(subjectKey: string, neg: boolean) {
    const latest = await labelStore.latestForSubject(subjectKey)
    const result = await labelStore.appendIfLatest(latest?.seq ?? null, {
      subjectKey,
      subjectKind: 'record',
      val: '!takedown',
      neg,
      boundaries: ['nerv'],
      createdBy: 'did:plc:gendo-ikari',
      createdAt: new Date().toISOString(),
    })
    expect(result.kind).toBe('appended')
  }

  it('(e2) listRepoOps leaves out the old create of a deleted taken-down record across responses', async () => {
    await appendEvent(REV.r1, [{ rkey: 'ayanami', cid: 'cidA' }])
    await appendEvent(REV.r2, [{ rkey: 'soryu', cid: 'cidB' }])
    await appendDelete('3cccc000000t3', 'ayanami')
    await indexPost('soryu')
    await appendLabel(uriOf('ayanami'), false)

    const ops: Array<[string, string | null]> = []
    let cursor: string | undefined
    let responses = 0
    do {
      const page = await listRepoOps(
        ctx,
        { did: repoDid, limit: 1, excludeValues: false, cursor },
        NERV,
      )
      responses++
      ops.push(
        ...page.ops.map((op): [string, string | null] => [op.rkey, op.cid]),
      )
      cursor = page.cursor
    } while (cursor !== undefined && responses < 10)

    expect(responses).toBeGreaterThan(1)
    expect(ops).toEqual([
      ['soryu', 'cidB'],
      ['ayanami', null],
    ])

    await appendLabel(uriOf('ayanami'), true)
    const afterNegation = await list(false)
    expect(afterNegation.ops.map((op) => [op.rkey, op.cid])).toEqual([
      ['ayanami', null],
      ['soryu', 'cidB'],
    ])
  })

  it('getTakedownStates maps marked rows to true and unmarked rows to false, and omits unknown uris', async () => {
    await indexPost('rei')
    await indexPost('asuka')
    await indexPost('shinji')
    await setTakedown('rei', true)
    await setTakedown('shinji', true)

    const found = await actorStore.read(repoDid, (store) =>
      store.record.getTakedownStates([
        uriOf('rei'),
        uriOf('asuka'),
        uriOf('shinji'),
        uriOf('kaworu'),
      ]),
    )
    const none = await actorStore.read(repoDid, (store) =>
      store.record.getTakedownStates([]),
    )

    expect(found).toEqual(
      new Map([
        [uriOf('rei'), true],
        [uriOf('asuka'), false],
        [uriOf('shinji'), true],
      ]),
    )
    expect(none).toEqual(new Map())
  })

  it('latestTakedowns returns exactly the keys whose latest label is a takedown', async () => {
    const key = (name: string) => `at://${repoDid}/${POST}/${name}`
    await appendLabel(key('takedown-then-negation'), false)
    await appendLabel(key('takedown-then-negation'), true)
    await appendLabel(key('negation-then-takedown'), true)
    await appendLabel(key('negation-then-takedown'), false)
    await appendLabel(key('takedown-only'), false)
    await appendLabel(key('negation-only'), true)

    const hidden = await labelStore.latestTakedowns([
      key('takedown-then-negation'),
      key('negation-then-takedown'),
      key('takedown-only'),
      key('negation-only'),
      key('never-labelled'),
    ])
    const none = await labelStore.latestTakedowns([])

    expect(hidden).toEqual(
      new Set([key('negation-then-takedown'), key('takedown-only')]),
    )
    expect(none).toEqual(new Set())
  })
})
