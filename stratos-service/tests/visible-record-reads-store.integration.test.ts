/**
 * Visible record reads through the runtime actor stores: the SQLite wrapper
 * and the Postgres store must answer the same way.
 *
 * Run: pnpm exec vitest run tests/visible-record-reads-store.integration.test.ts
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { MAX_VISIBLE_RECORD_BATCH } from '@northskysocial/stratos-core'
import type { ActorStore } from '../src/actor-store-types.js'
import { StratosActorStore } from '../src/storage/sqlite/actor-store.js'
import { PostgresActorStore } from '../src/infra/storage/postgres/index.js'
import {
  cborToRecord,
  createCid,
  createMockBlobStoreCreator,
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const ENGINEERING = 'did:web:nerv.tokyo.jp/engineering'
const LEADERSHIP = 'did:web:nerv.tokyo.jp/leadership'
const OPERATIONS = 'did:web:nerv.tokyo.jp/operations'

const ownerDid = 'did:plc:misato-katsuragi'

const uriOf = (rkey: string) =>
  `at://${ownerDid}/zone.stratos.feed.post/${rkey}`

const bodyClaiming = (text: string, ...boundaries: string[]) => ({
  $type: 'zone.stratos.feed.post',
  text,
  boundary: {
    $type: 'zone.stratos.boundary.defs#Domains',
    values: boundaries.map((value) => ({ value })),
  },
})

const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value))

describe.each(['sqlite', 'postgres'] as const)(
  'visible record reads on %s',
  (backend) => {
    let actorStore: ActorStore
    let dataDir: string | undefined
    let closeBackend: () => Promise<void>

    beforeAll(async () => {
      if (backend === 'postgres') {
        const connectionString = await startPostgresContainer()
        const postgresStore = new PostgresActorStore({
          connectionString,
          blobstore: createMockBlobStoreCreator(),
          cborToRecord,
        })
        actorStore = postgresStore
        closeBackend = async () => {
          await postgresStore.close()
          await stopPostgresContainer()
        }
        return
      }
      dataDir = join(
        tmpdir(),
        `stratos-visible-reads-${randomBytes(8).toString('hex')}`,
      )
      await mkdir(dataDir, { recursive: true })
      actorStore = new StratosActorStore({
        dataDir,
        blobstore: createMockBlobStoreCreator(),
        cborToRecord,
      })
      closeBackend = async () => {
        await rm(dataDir!, { recursive: true, force: true })
      }
    }, 120_000)

    // Stopping the Postgres container can outlast the default hook timeout
    // when the whole suite runs at once.
    afterAll(async () => {
      await closeBackend()
    }, 60_000)

    beforeEach(async () => {
      await actorStore.create(ownerDid)
    })

    afterEach(async () => {
      await actorStore.destroy(ownerDid)
    })

    const seed = async (
      rkey: string,
      claimed: string[],
      stored: string,
    ): Promise<Record<string, unknown>> => {
      const body = bodyClaiming(`sync ratio ${rkey}`, ...claimed)
      const cid = await createCid(`record ${rkey}`)
      await actorStore.transact(ownerDid, async (store) => {
        await store.record.putRecord({
          uri: uriOf(rkey),
          cid,
          value: body,
          content: encode(body),
        })
        await store.record.indexRecordInBoundary(
          uriOf(rkey),
          cid,
          body,
          stored,
          'update',
          'rev1',
        )
      })
      return body
    }

    const seedClaimingAll = async (
      rkey: string,
      boundaries: string[],
    ): Promise<Record<string, unknown>> => {
      const body = bodyClaiming(`sync ratio ${rkey}`, ...boundaries)
      await actorStore.transact(ownerDid, async (store) => {
        await store.record.putRecord({
          uri: uriOf(rkey),
          cid: await createCid(`record ${rkey}`),
          value: body,
          content: encode(body),
        })
      })
      return body
    }

    const takeDown = (rkey: string) =>
      actorStore.transact(ownerDid, (store) =>
        store.record.updateRecordTakedown(uriOf(rkey), {
          applied: true,
          ref: 'TD-NERV',
        }),
      )

    const readOne = (rkey: string) =>
      actorStore.read(ownerDid, (store) =>
        store.record.getVisibleRecordWithBoundaries(uriOf(rkey)),
      )

    const readMany = (uris: string[]) =>
      actorStore.read(ownerDid, (store) =>
        store.record.getVisibleRecordsWithBoundaries(uris),
      )

    it('returns the record exactly as getRecord does, with its rows sorted ascending', async () => {
      const body = await seedClaimingAll('rei', [OPERATIONS, ENGINEERING])

      const found = await readOne('rei')
      const plain = await actorStore.read(ownerDid, (store) =>
        store.record.getRecord(uriOf('rei'), null),
      )

      expect(found).toEqual({
        record: plain,
        boundaries: [ENGINEERING, OPERATIONS],
      })
      expect(found?.record.value).toEqual(body)
    })

    it('returns [] for a record without rows', async () => {
      await seedClaimingAll('shinji', [])

      const found = await readOne('shinji')

      expect(found?.boundaries).toEqual([])
      expect(found?.record.uri).toBe(uriOf('shinji'))
    })

    it('returns null for a missing record', async () => {
      expect(await readOne('kaworu')).toBeNull()
    })

    it('returns null for a taken-down record', async () => {
      await seed('gendo', [LEADERSHIP], LEADERSHIP)
      await takeDown('gendo')

      expect(await readOne('gendo')).toBeNull()
      const plain = await actorStore.read(ownerDid, (store) =>
        store.record.getRecord(uriOf('gendo'), null),
      )
      expect(plain).toBeNull()
    })

    it('never returns the boundary the body claims', async () => {
      await seed('asuka', [LEADERSHIP], ENGINEERING)

      expect((await readOne('asuka'))?.boundaries).toEqual([ENGINEERING])
    })

    it('does not mix in the rows of another record', async () => {
      await seed('ritsuko', [], ENGINEERING)
      await seed('kaji', [], LEADERSHIP)

      expect((await readOne('ritsuko'))?.boundaries).toEqual([ENGINEERING])
    })

    it('keeps visible records keyed by uri and omits missing and taken-down ones', async () => {
      await seedClaimingAll('rei', [OPERATIONS, ENGINEERING])
      await seedClaimingAll('shinji', [])
      await seed('gendo', [], LEADERSHIP)
      await takeDown('gendo')

      const found = await readMany([
        uriOf('rei'),
        uriOf('shinji'),
        uriOf('gendo'),
        uriOf('kaworu'),
      ])

      expect([...found.keys()].sort()).toEqual(
        [uriOf('rei'), uriOf('shinji')].sort(),
      )
      expect(found.get(uriOf('rei'))?.boundaries).toEqual([
        ENGINEERING,
        OPERATIONS,
      ])
      expect(found.get(uriOf('shinji'))?.boundaries).toEqual([])
    })

    it('returns each record with its own rows in a batch', async () => {
      await seed('misato', [LEADERSHIP], ENGINEERING)
      await seedClaimingAll('ritsuko', [OPERATIONS, LEADERSHIP])

      const found = await readMany([uriOf('misato'), uriOf('ritsuko')])

      expect(found.get(uriOf('misato'))?.boundaries).toEqual([ENGINEERING])
      expect(found.get(uriOf('ritsuko'))?.boundaries).toEqual([
        LEADERSHIP,
        OPERATIONS,
      ])
    })

    it('accepts exactly the bound', async () => {
      const uris = Array.from({ length: MAX_VISIBLE_RECORD_BATCH }, (_, i) =>
        uriOf(`angel-${i}`),
      )

      expect((await readMany(uris)).size).toBe(0)
    })

    it('throws above the bound', async () => {
      const uris = Array.from(
        { length: MAX_VISIBLE_RECORD_BATCH + 1 },
        (_, i) => uriOf(`angel-${i}`),
      )

      await expect(readMany(uris)).rejects.toThrow(/at most 100/)
    })
  },
)
