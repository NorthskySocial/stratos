/**
 * PostgreSQL backend integration tests using testcontainers.
 *
 * Automatically starts a PostgreSQL container — no external database needed.
 * Requires Docker to be running.
 *
 * Run: pnpm exec vitest run tests/postgres-integration.test.ts
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
import {
  cborToRecord,
  createCid,
  createMockBlobStoreCreator,
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'
import {
  closeServicePgDb,
  createServicePgDb,
  migrateServicePgDb,
  type ServicePgDb,
} from '../src/db/pg.js'
import type { ActorStore } from '../src/actor-store-types.js'
import postgres from 'postgres'
import {
  PgEnrollmentStoreWriter,
  PostgresActorStore,
} from '../src/infra/storage/postgres/index.js'
import { PgPdsSyncQueueStore } from '../src/features/enrollment/internal/pds-sync-store.js'
import { PgLabelStore } from '../src/features/moderation/index.js'
import { createStratosPgDb, type NewLabel } from '@northskysocial/stratos-core'
import { sql } from 'drizzle-orm'

describe('PostgreSQL Backend Integration', () => {
  let pgUrl: string
  let actorStore: ActorStore
  let serviceDb: ServicePgDb
  let enrollmentStore: PgEnrollmentStoreWriter
  let cleanupClient: postgres.Sql

  const testDid = 'did:plc:pgtest123'
  const testDid2 = 'did:plc:pgtest456'

  beforeAll(async () => {
    pgUrl = await startPostgresContainer()

    cleanupClient = postgres(pgUrl, { max: 1 })

    serviceDb = createServicePgDb(pgUrl)
    await migrateServicePgDb(serviceDb)

    enrollmentStore = new PgEnrollmentStoreWriter(serviceDb)

    actorStore = new PostgresActorStore({
      connectionString: pgUrl,
      blobstore: createMockBlobStoreCreator(),
      cborToRecord,
    })
  }, 120_000)

  afterAll(async () => {
    await cleanupClient.end()
    await stopPostgresContainer()
  }, 60_000)

  afterEach(async () => {
    for (const did of [testDid, testDid2]) {
      try {
        await actorStore.destroy(did)
      } catch {
        // ignore if not created
      }
    }

    await cleanupClient`DELETE FROM enrollment_boundary`
    await cleanupClient`DELETE FROM enrollment`
  })

  it('selects the actor schema on each pooled connection', async () => {
    await cleanupClient`CREATE SCHEMA nerv`
    const db = createStratosPgDb(pgUrl, 'nerv')
    try {
      await db.transaction(async (tx) => {
        const statement = sql`SELECT current_schema() AS schema, pg_backend_pid() AS pid`
        const [first] = await tx.execute(statement, 'objects')
        const [second] = await db.execute(statement, 'objects')
        expect([first.schema, second.schema]).toEqual(['nerv', 'nerv'])
        expect(first.pid).not.toBe(second.pid)
      })
    } finally {
      await db.$client.end()
      await cleanupClient`DROP SCHEMA nerv`
    }
  })

  describe('Service Schema Migration', () => {
    it('removes the redundant did index and keeps required indexes', async () => {
      await cleanupClient`
        CREATE INDEX IF NOT EXISTS enrollment_boundary_did_idx
        ON enrollment_boundary(did)
      `

      await migrateServicePgDb(serviceDb)

      const indexes = await cleanupClient<Array<{ indexName: string }>>`
        SELECT indexname AS "indexName"
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'enrollment_boundary'
      `
      const indexNames = indexes.map((index) => index.indexName)

      expect(indexNames).not.toContain('enrollment_boundary_did_idx')
      expect(indexNames).toContain('enrollment_boundary_pkey')
      expect(indexNames).toContain('enrollment_boundary_boundary_idx')
    })
  })

  describe('Actor Lifecycle', () => {
    it('should create and check actor existence', async () => {
      expect(await actorStore.exists(testDid)).toBe(false)
      await actorStore.create(testDid)
      expect(await actorStore.exists(testDid)).toBe(true)
    })

    it('should destroy an actor', async () => {
      await actorStore.create(testDid)
      expect(await actorStore.exists(testDid)).toBe(true)
      await actorStore.destroy(testDid)
      expect(await actorStore.exists(testDid)).toBe(false)
    })

    it('should isolate actors in separate schemas', async () => {
      await actorStore.create(testDid)
      await actorStore.create(testDid2)

      const cid = await createCid('isolation test')

      await actorStore.transact(testDid, async (store) => {
        await store.record.indexRecord(
          `at://${testDid}/zone.stratos.feed.post/1`,
          cid,
          { text: 'Actor 1 post' },
          'create',
          'rev1',
        )
      })

      const count1 = await actorStore.read(testDid, (s) =>
        s.record.recordCount(),
      )
      const count2 = await actorStore.read(testDid2, (s) =>
        s.record.recordCount(),
      )

      expect(count1).toBe(1)
      expect(count2).toBe(0)
    })
  })

  describe('Record Operations', () => {
    beforeEach(async () => {
      await actorStore.create(testDid)
    })

    it('should create and read a record', async () => {
      const uri = `at://${testDid}/zone.stratos.feed.post/123`
      const cid = await createCid('test record')

      await actorStore.transact(testDid, async (store) => {
        await store.record.indexRecord(
          uri,
          cid,
          { text: 'Hello PG!' },
          'create',
          'rev1',
        )
      })

      const count = await actorStore.read(testDid, (s) =>
        s.record.recordCount(),
      )
      expect(count).toBe(1)
    })

    it('should list records by collection', async () => {
      const cid = await createCid('list test')

      await actorStore.transact(testDid, async (store) => {
        await store.record.indexRecord(
          `at://${testDid}/zone.stratos.feed.post/1`,
          cid,
          { text: 'Post 1' },
          'create',
          'rev1',
        )
        await store.record.indexRecord(
          `at://${testDid}/zone.stratos.feed.post/2`,
          cid,
          { text: 'Post 2' },
          'create',
          'rev1',
        )
        await store.record.indexRecord(
          `at://${testDid}/zone.stratos.graph.follow/1`,
          cid,
          { subject: 'did:plc:other' },
          'create',
          'rev1',
        )
      })

      const collections = await actorStore.read(testDid, (s) =>
        s.record.listCollections(),
      )
      expect(collections).toHaveLength(2)
      expect(collections).toContain('zone.stratos.feed.post')
      expect(collections).toContain('zone.stratos.graph.follow')
    })

    it('should delete a record', async () => {
      const uri = `at://${testDid}/zone.stratos.feed.post/todelete`
      const cid = await createCid('delete me')

      await actorStore.transact(testDid, async (store) => {
        await store.record.indexRecord(
          uri,
          cid,
          { text: 'Delete me' },
          'create',
          'rev1',
        )
      })

      expect(
        await actorStore.read(testDid, (s) => s.record.recordCount()),
      ).toBe(1)

      await actorStore.transact(testDid, async (store) => {
        await store.record.deleteRecord(uri)
      })

      expect(
        await actorStore.read(testDid, (s) => s.record.recordCount()),
      ).toBe(0)
    })

    it('should manage backlinks', async () => {
      const postUri = `at://${testDid}/zone.stratos.feed.post/withlinks`
      const cid = await createCid('post with links')

      await actorStore.transact(testDid, async (store) => {
        await store.record.indexRecord(
          postUri,
          cid,
          {
            text: 'Reply',
            reply: {
              parent: { uri: 'at://did:plc:other/zone.stratos.feed.post/123' },
            },
          },
          'create',
          'rev1',
        )
        await store.record.addBacklinks([
          {
            uri: postUri,
            path: 'reply.parent.uri',
            linkTo: 'at://did:plc:other/zone.stratos.feed.post/123',
          },
        ])
      })

      const backlinks = await actorStore.read(testDid, async (store) => {
        return store.record.getRecordBacklinks({
          collection: 'zone.stratos.feed.post',
          path: 'reply.parent.uri',
          linkTo: 'at://did:plc:other/zone.stratos.feed.post/123',
        })
      })

      expect(backlinks).toHaveLength(1)
      expect(backlinks[0].uri).toBe(postUri)
    })
  })

  describe('listBlobsForBoundary takedown filtering', () => {
    const BOUNDARY = 'nerv'
    const OTHER_BOUNDARY = 'seele'
    const TAKEDOWN_REF = 'takedown-ref-nerv'
    const WITHOUT_SINCE = undefined
    const WITH_SINCE = 'rev0'

    const recordUriOf = (rkey: string) =>
      `at://${testDid}/zone.stratos.feed.post/${rkey}`

    const addRecordWithBlob = async (opts: {
      rkey: string
      blobSeed: string
      boundaries: string[]
      repoRev?: string
    }): Promise<string> => {
      const blobCid = await createCid(opts.blobSeed)
      const uri = recordUriOf(opts.rkey)
      await actorStore.transact(testDid, async (store) => {
        await store.record.indexRecord(
          uri,
          await createCid(`record ${opts.rkey}`),
          {
            text: opts.rkey,
            boundary: {
              $type: 'zone.stratos.boundary.defs#Domains',
              values: opts.boundaries.map((value) => ({ value })),
            },
          },
          'create',
          opts.repoRev ?? 'rev1',
        )
        await store.blob.associateBlobWithRecord(blobCid, uri)
      })
      return blobCid.toString()
    }

    const trackBlobRow = (blobSeed: string) =>
      actorStore.transact(testDid, async (store) => {
        await store.blob.trackBlob({
          cid: await createCid(blobSeed),
          mimeType: 'image/png',
          size: 1,
        })
      })

    const markRecord = (rkey: string, ref: string | null) =>
      actorStore.transact(testDid, (store) =>
        store.record.updateRecordTakedown(
          recordUriOf(rkey),
          ref === null ? { applied: false } : { applied: true, ref },
        ),
      )

    const markBlob = (blobSeed: string, ref: string | null) =>
      actorStore.transact(testDid, async (store) =>
        store.blob.updateBlobTakedown(
          await createCid(blobSeed),
          ref === null ? { applied: false } : { applied: true, ref },
        ),
      )

    const list = (boundary: string, since: string | undefined) =>
      actorStore.read(testDid, (store) =>
        store.blob.listBlobsForBoundary({ boundary, since, limit: 50 }),
      )

    beforeEach(async () => {
      await actorStore.create(testDid)
    })

    it('omits a blob whose only in-boundary record is taken down', async () => {
      const hidden = await addRecordWithBlob({
        rkey: 'ikari',
        blobSeed: 'ikari blob',
        boundaries: [BOUNDARY],
      })
      const visible = await addRecordWithBlob({
        rkey: 'hikari',
        blobSeed: 'hikari blob',
        boundaries: [BOUNDARY],
      })
      await markRecord('ikari', TAKEDOWN_REF)

      for (const since of [WITHOUT_SINCE, WITH_SINCE]) {
        const result = await list(BOUNDARY, since)
        expect(result).toEqual([visible])
        expect(result).not.toContain(hidden)
      }
    })

    it('lists a blob that still has a live in-boundary record', async () => {
      const shared = await addRecordWithBlob({
        rkey: 'toji-a',
        blobSeed: 'toji shared blob',
        boundaries: [BOUNDARY],
      })
      await addRecordWithBlob({
        rkey: 'toji-b',
        blobSeed: 'toji shared blob',
        boundaries: [BOUNDARY],
      })
      await markRecord('toji-a', TAKEDOWN_REF)

      for (const since of [WITHOUT_SINCE, WITH_SINCE]) {
        expect(await list(BOUNDARY, since)).toEqual([shared])
      }
    })

    it('judges since and takedown on the same record', async () => {
      const shared = await addRecordWithBlob({
        rkey: 'gendo-old',
        blobSeed: 'gendo shared blob',
        boundaries: [BOUNDARY],
        repoRev: 'rev1',
      })
      await addRecordWithBlob({
        rkey: 'gendo-new',
        blobSeed: 'gendo shared blob',
        boundaries: [BOUNDARY],
        repoRev: 'rev3',
      })
      await markRecord('gendo-new', TAKEDOWN_REF)

      expect(await list(BOUNDARY, 'rev2')).not.toContain(shared)
      expect(await list(BOUNDARY, 'rev0')).toEqual([shared])
    })

    it('judges a taken-down record only within its own boundary', async () => {
      const shared = await addRecordWithBlob({
        rkey: 'misato-a',
        blobSeed: 'misato shared blob',
        boundaries: [BOUNDARY],
      })
      await addRecordWithBlob({
        rkey: 'misato-b',
        blobSeed: 'misato shared blob',
        boundaries: [OTHER_BOUNDARY],
      })
      await markRecord('misato-a', TAKEDOWN_REF)

      for (const since of [WITHOUT_SINCE, WITH_SINCE]) {
        expect(await list(BOUNDARY, since)).toEqual([])
        expect(await list(OTHER_BOUNDARY, since)).toEqual([shared])
      }
    })

    it('omits a taken-down blob that has a live in-boundary record', async () => {
      const hidden = await addRecordWithBlob({
        rkey: 'nagisa',
        blobSeed: 'nagisa blob',
        boundaries: [BOUNDARY],
      })
      const visible = await addRecordWithBlob({
        rkey: 'mari',
        blobSeed: 'mari blob',
        boundaries: [BOUNDARY],
      })
      await trackBlobRow('nagisa blob')
      await markBlob('nagisa blob', TAKEDOWN_REF)

      for (const since of [WITHOUT_SINCE, WITH_SINCE]) {
        const result = await list(BOUNDARY, since)
        expect(result).toEqual([visible])
        expect(result).not.toContain(hidden)
      }
    })

    it('lists a live blob that has no stratos_blob row', async () => {
      const untracked = await addRecordWithBlob({
        rkey: 'asuka',
        blobSeed: 'asuka blob',
        boundaries: [BOUNDARY],
      })
      const hasRow = await actorStore.read(testDid, async (store) =>
        store.blob.hasBlob(await createCid('asuka blob')),
      )
      expect(hasRow).toBe(false)

      for (const since of [WITHOUT_SINCE, WITH_SINCE]) {
        expect(await list(BOUNDARY, since)).toEqual([untracked])
      }
    })

    it('lists a blob again once either marker is cleared', async () => {
      const recordHidden = await addRecordWithBlob({
        rkey: 'maya',
        blobSeed: 'maya blob',
        boundaries: [BOUNDARY],
      })
      const blobHidden = await addRecordWithBlob({
        rkey: 'fuyutsuki',
        blobSeed: 'fuyutsuki blob',
        boundaries: [BOUNDARY],
      })
      await trackBlobRow('fuyutsuki blob')
      await markRecord('maya', TAKEDOWN_REF)
      await markBlob('fuyutsuki blob', TAKEDOWN_REF)
      expect(await list(BOUNDARY, WITHOUT_SINCE)).toEqual([])

      await markRecord('maya', null)
      await markBlob('fuyutsuki blob', null)

      for (const since of [WITHOUT_SINCE, WITH_SINCE]) {
        expect(await list(BOUNDARY, since)).toEqual(
          [recordHidden, blobHidden].sort(),
        )
      }
    })

    it('pages in full without gaps or repeats across hidden blobs', async () => {
      const names = [
        'usagi',
        'mamoru',
        'ami',
        'rei',
        'makoto',
        'minako',
        'luna',
        'artemis',
      ]
      const rkeyByBlob = new Map<string, string>()
      const seedByBlob = new Map<string, string>()
      for (const name of names) {
        const blobCid = await addRecordWithBlob({
          rkey: name,
          blobSeed: `${name} blob`,
          boundaries: [BOUNDARY],
        })
        rkeyByBlob.set(blobCid, name)
        seedByBlob.set(blobCid, `${name} blob`)
        await trackBlobRow(`${name} blob`)
      }
      const ordered = [...rkeyByBlob.keys()].sort()
      // Hidden entries sit at the edge and between live ones in CID order,
      // alternating between the record marker and the blob marker.
      await markRecord(rkeyByBlob.get(ordered[0])!, TAKEDOWN_REF)
      await markBlob(seedByBlob.get(ordered[2])!, TAKEDOWN_REF)
      await markRecord(rkeyByBlob.get(ordered[3])!, TAKEDOWN_REF)
      const expectedLive = [1, 4, 5, 6, 7].map((index) => ordered[index])

      for (const since of [WITHOUT_SINCE, WITH_SINCE]) {
        const pages: string[][] = []
        let cursor: string | undefined
        for (;;) {
          const page = await actorStore.read(testDid, (store) =>
            store.blob.listBlobsForBoundary({
              boundary: BOUNDARY,
              since,
              cursor,
              limit: 2,
            }),
          )
          if (page.length === 0) break
          pages.push(page)
          cursor = page[page.length - 1]
          if (page.length < 2) break
        }

        expect(pages.slice(0, -1).every((page) => page.length === 2)).toBe(true)
        const flattened = pages.flat()
        expect(new Set(flattened).size).toBe(flattened.length)
        expect(flattened).toEqual(expectedLive)
        expect(pages).toHaveLength(Math.ceil(expectedLive.length / 2))
      }
    })
  })

  describe('backlink takedown filtering', () => {
    const COLLECTION = 'zone.stratos.graph.follow'
    const TARGET = 'did:plc:lain'
    const uriOf = (collection: string, rkey: string) =>
      `at://${testDid}/${collection}/${rkey}`
    const liveUri = uriOf(COLLECTION, 'ed')
    const hiddenUri = uriOf(COLLECTION, 'faye')
    const newUri = uriOf(COLLECTION, 'jet')
    const otherCollectionUri = uriOf('zone.stratos.feed.like', 'spike')

    const markHidden = (ref: string | null) =>
      actorStore.transact(testDid, (store) =>
        store.record.updateRecordTakedown(
          hiddenUri,
          ref === null ? { applied: false } : { applied: true, ref },
        ),
      )

    const query = () =>
      actorStore.read(testDid, (store) =>
        store.record.getRecordBacklinks({
          collection: COLLECTION,
          path: 'subject',
          linkTo: TARGET,
        }),
      )

    beforeEach(async () => {
      await actorStore.create(testDid)
      await actorStore.transact(testDid, async (store) => {
        for (const uri of [liveUri, hiddenUri, otherCollectionUri]) {
          await store.record.indexRecord(
            uri,
            await createCid(uri),
            { subject: TARGET },
            'create',
            'rev1',
          )
        }
        await store.record.addBacklinks(
          [liveUri, hiddenUri, otherCollectionUri].map((uri) => ({
            uri,
            path: 'subject',
            linkTo: TARGET,
          })),
        )
      })
      await markHidden('TD-LAIN')
    })

    it('getRecordBacklinks omits taken-down records', async () => {
      const rows = await query()

      expect(rows.map((row) => row.uri)).toEqual([liveUri])
    })

    it('getRecordBacklinks returns a record again once the takedown is cleared', async () => {
      const whileTakenDown = await query()
      await markHidden(null)

      const rows = await query()

      expect(whileTakenDown.map((row) => row.uri)).toEqual([liveUri])
      expect(rows.map((row) => row.uri).sort()).toEqual([liveUri, hiddenUri])
    })

    it('getBacklinkConflicts still reports taken-down records', async () => {
      const conflicts = await actorStore.read(testDid, (store) =>
        store.record.getBacklinkConflicts(newUri, { subject: TARGET }),
      )

      expect(conflicts.map((conflict) => conflict.toString()).sort()).toEqual([
        liveUri,
        hiddenUri,
      ])
    })

    it('getRecordBacklinks ignores records in other collections', async () => {
      const rows = await query()

      expect(rows.map((row) => row.uri)).not.toContain(otherCollectionUri)
    })
  })

  describe('getRecordBoundaries', () => {
    const EVA = 'did:web:nerv.tokyo.jp/eva'
    const ANGEL = 'did:web:nerv.tokyo.jp/angel'
    const SEELE = 'did:web:nerv.tokyo.jp/seele'

    const uriOf = (rkey: string) =>
      `at://${testDid}/zone.stratos.feed.post/${rkey}`

    const bodyWith = (...boundaries: string[]) => ({
      $type: 'zone.stratos.feed.post',
      text: 'sync ratio',
      boundary: {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: boundaries.map((value) => ({ value })),
      },
    })

    const index = (rkey: string, ...boundaries: string[]) =>
      actorStore.transact(testDid, async (store) => {
        await store.record.indexRecord(
          uriOf(rkey),
          await createCid(`record ${rkey}`),
          bodyWith(...boundaries),
          'create',
          'rev1',
        )
      })

    const read = (rkey: string) =>
      actorStore.read(testDid, (store) =>
        store.record.getRecordBoundaries(uriOf(rkey)),
      )

    const boundaryTable = async () => {
      const [found] = await cleanupClient<{ schemaname: string }[]>`
        SELECT schemaname FROM pg_tables
        WHERE tablename = 'stratos_record_boundary'
          AND schemaname LIKE 'actor_%'`
      return `"${found.schemaname}".stratos_record_boundary`
    }

    const insertBoundaryRow = async (rkey: string, boundary: string) =>
      cleanupClient.unsafe(
        `INSERT INTO ${await boundaryTable()} ("recordUri", "boundary") VALUES ($1, $2)`,
        [uriOf(rkey), boundary],
      )

    beforeEach(async () => {
      await actorStore.create(testDid)
    })

    it('returns every row of a record, sorted ascending', async () => {
      await index('rei', SEELE, ANGEL, EVA)

      expect(await read('rei')).toEqual([ANGEL, EVA, SEELE])
    })

    it('cannot store a boundary twice, so a record lists each once', async () => {
      await index('asuka', EVA)

      await expect(insertBoundaryRow('asuka', EVA)).rejects.toThrow()
      expect(await read('asuka')).toEqual([EVA])
    })

    it('returns [] for a record without rows', async () => {
      await index('shinji')

      expect(await read('shinji')).toEqual([])
    })

    it('returns [] for an unknown uri', async () => {
      expect(await read('kaworu')).toEqual([])
    })

    it('does not return rows of another record', async () => {
      await index('ritsuko', EVA)
      await index('maya', SEELE)

      expect(await read('ritsuko')).toEqual([EVA])
      expect(await read('maya')).toEqual([SEELE])
    })

    it('still returns boundaries of a taken-down record', async () => {
      await index('gendo', EVA, ANGEL)
      await actorStore.transact(testDid, (store) =>
        store.record.updateRecordTakedown(uriOf('gendo'), {
          applied: true,
          ref: 'TD-GENDO',
        }),
      )

      expect(await read('gendo')).toEqual([ANGEL, EVA])
    })

    it('returns stored rows, not the boundary claimed by the record body', async () => {
      await index('kaji', EVA)
      await cleanupClient.unsafe(
        `DELETE FROM ${await boundaryTable()} WHERE "recordUri" = $1`,
        [uriOf('kaji')],
      )
      await insertBoundaryRow('kaji', SEELE)

      expect(await read('kaji')).toEqual([SEELE])
    })
  })

  describe('Repo Operations', () => {
    beforeEach(async () => {
      await actorStore.create(testDid)
    })

    it('should store and retrieve blocks', async () => {
      const cid = await createCid('block content')
      const content = new TextEncoder().encode('block bytes')

      await actorStore.transact(testDid, async (store) => {
        await store.repo.putBlock(cid, content, 'rev1')
      })

      const retrieved = await actorStore.read(testDid, async (store) => {
        return store.repo.getBytes(cid)
      })

      expect(retrieved).toEqual(content)
    })

    it('should manage repo root', async () => {
      const rootCid = await createCid('root commit')

      await actorStore.transact(testDid, async (store) => {
        await store.repo.updateRoot(rootCid, 'rev1', testDid)
      })

      const root = await actorStore.read(testDid, (s) => s.repo.getRoot())
      expect(root?.toString()).toBe(rootCid.toString())
    })

    it('should count blocks', async () => {
      const cid1 = await createCid('block1')
      const cid2 = await createCid('block2')
      const content = new TextEncoder().encode('bytes')

      await actorStore.transact(testDid, async (store) => {
        await store.repo.putBlock(cid1, content, 'rev1')
        await store.repo.putBlock(cid2, content, 'rev1')
      })

      const count = await actorStore.read(testDid, (s) => s.repo.countBlocks())
      expect(count).toBe(2)
    })
  })

  describe('Sequence Operations', () => {
    beforeEach(async () => {
      await actorStore.create(testDid)
    })

    it('should append and retrieve sequence events', async () => {
      await actorStore.transact(testDid, async (store) => {
        await store.sequence.appendEvent({
          did: testDid,
          eventType: 'append',
          event: Buffer.from(
            JSON.stringify({
              action: 'create',
              path: 'zone.stratos.feed.post/1',
            }),
          ),
          invalidated: 0,
          sequencedAt: new Date().toISOString(),
        })
      })

      const latestSeq = await actorStore.read(testDid, (s) =>
        s.sequence.getLatestSeq(),
      )
      expect(latestSeq).toBeGreaterThan(0)
    })

    it('should get events since cursor', async () => {
      await actorStore.transact(testDid, async (store) => {
        await store.sequence.appendEvent({
          did: testDid,
          eventType: 'append',
          event: Buffer.from(
            JSON.stringify({
              action: 'create',
              path: 'zone.stratos.feed.post/1',
            }),
          ),
          invalidated: 0,
          sequencedAt: new Date().toISOString(),
        })
        await store.sequence.appendEvent({
          did: testDid,
          eventType: 'append',
          event: Buffer.from(
            JSON.stringify({
              action: 'create',
              path: 'zone.stratos.feed.post/2',
            }),
          ),
          invalidated: 0,
          sequencedAt: new Date().toISOString(),
        })
      })

      const events = await actorStore.read(testDid, (s) =>
        s.sequence.getEventsSince(0, 100),
      )
      expect(events.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('Enrollment Store (PG)', () => {
    it('should enroll and check enrollment', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        pdsEndpoint: 'https://pds.example.com',
        signingKeyDid: 'did:key:zSpikeSpiegelBebop1',
        active: true,
        enrollmentRkey: 'did:web:stratos.example.com',
      })

      expect(await enrollmentStore.isEnrolled(testDid)).toBe(true)
      expect(await enrollmentStore.isEnrolled('did:plc:nonexistent')).toBe(
        false,
      )
    })

    it('should get enrollment details', async () => {
      const enrolledAt = new Date().toISOString()
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt,
        pdsEndpoint: 'https://pds.example.com',
        signingKeyDid: 'did:key:zFayeValentineBebop1',
        active: true,
        enrollmentRkey: 'did:web:stratos.example.com',
      })

      const enrollment = await enrollmentStore.getEnrollment(testDid)
      expect(enrollment).toBeTruthy()
      expect(enrollment!.did).toBe(testDid)
      expect(enrollment!.pdsEndpoint).toBe('https://pds.example.com')
      expect(enrollment!.enrollmentRkey).toBe('did:web:stratos.example.com')
    })

    it('should manage boundaries', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zJetBlackBebop1',
        active: true,
      })

      await enrollmentStore.setBoundaries(testDid, [
        'did:web:nerv.tokyo.jp/engineering',
        'did:web:nerv.tokyo.jp/design',
      ])
      let boundaries = await enrollmentStore.getBoundaries(testDid)
      expect(boundaries).toHaveLength(2)
      expect(boundaries).toContain('did:web:nerv.tokyo.jp/engineering')
      expect(boundaries).toContain('did:web:nerv.tokyo.jp/design')

      await enrollmentStore.addBoundary(
        testDid,
        'did:web:nerv.tokyo.jp/leadership',
      )
      boundaries = await enrollmentStore.getBoundaries(testDid)
      expect(boundaries).toHaveLength(3)

      await enrollmentStore.removeBoundary(
        testDid,
        'did:web:nerv.tokyo.jp/design',
      )
      boundaries = await enrollmentStore.getBoundaries(testDid)
      expect(boundaries).toHaveLength(2)
      expect(boundaries).not.toContain('did:web:nerv.tokyo.jp/design')
    })

    it('should list active enrollments carrying a boundary, excluding inactive and other-boundary rows', async () => {
      const BOUNDARY = 'did:web:nerv.tokyo.jp/pilots'
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zAsukaLangley1',
        active: true,
      })
      await enrollmentStore.setBoundaries(testDid, [BOUNDARY])

      await enrollmentStore.enroll({
        did: testDid2,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zShinjiIkari1',
        active: false,
      })
      await enrollmentStore.setBoundaries(testDid2, [BOUNDARY])

      // Called with no options at all -- exercises the default limit/cursor.
      const members = await enrollmentStore.listEnrollmentsByBoundary(BOUNDARY)
      expect(members.map((m) => m.did)).toEqual([testDid])
    })

    it('should paginate listEnrollmentsByBoundary with a cursor', async () => {
      const BOUNDARY = 'did:web:nerv.tokyo.jp/eva'
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zReiAyanami1',
        active: true,
      })
      await enrollmentStore.setBoundaries(testDid, [BOUNDARY])

      await enrollmentStore.enroll({
        did: testDid2,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zMariMakinami1',
        active: true,
      })
      await enrollmentStore.setBoundaries(testDid2, [BOUNDARY])

      const firstPage = await enrollmentStore.listEnrollmentsByBoundary(
        BOUNDARY,
        { limit: 1 },
      )
      expect(firstPage).toHaveLength(1)

      const secondPage = await enrollmentStore.listEnrollmentsByBoundary(
        BOUNDARY,
        { cursor: firstPage[0].did },
      )
      expect(secondPage.map((m) => m.did)).not.toContain(firstPage[0].did)
      expect([...firstPage, ...secondPage].map((m) => m.did).sort()).toEqual(
        [testDid, testDid2].sort(),
      )
    })

    it('should unenroll', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zEdwardWongBebop1',
        active: true,
      })

      expect(await enrollmentStore.isEnrolled(testDid)).toBe(true)
      await enrollmentStore.unenroll(testDid)
      expect(await enrollmentStore.isEnrolled(testDid)).toBe(false)
    })

    it('should list enrollments', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zViciousBebop1',
        active: true,
      })
      await enrollmentStore.enroll({
        did: testDid2,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zJuliaBebop1',
        active: true,
      })

      const enrollments = await enrollmentStore.listEnrollments()
      expect(enrollments.length).toBeGreaterThanOrEqual(2)
    })

    it('should store and retrieve enrollmentRkey', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        pdsEndpoint: 'https://pds.example.com',
        signingKeyDid: 'did:key:zMusashiMiyamotoBebop1',
        active: true,
        enrollmentRkey: 'did:web:stratos.example.com',
      })

      const result = await enrollmentStore.getEnrollment(testDid)
      expect(result?.enrollmentRkey).toBe('did:web:stratos.example.com')
    })

    it('should return undefined enrollmentRkey when not set', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zLinBebop1',
        active: true,
      })

      const result = await enrollmentStore.getEnrollment(testDid)
      expect(result?.enrollmentRkey).toBeUndefined()
    })

    it('should update enrollmentRkey on re-enrollment', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zAndieBebop1',
        active: true,
        enrollmentRkey: 'did:web:old-stratos.example.com',
      })

      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zAndieBebop1',
        active: true,
        enrollmentRkey: 'did:web:stratos.example.com',
      })

      const result = await enrollmentStore.getEnrollment(testDid)
      expect(result?.enrollmentRkey).toBe('did:web:stratos.example.com')
    })

    it('should update enrollmentRkey via updateEnrollment', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zGrenBebop1',
        active: true,
      })

      await enrollmentStore.updateEnrollment(testDid, {
        enrollmentRkey: 'did:web:stratos.example.com',
      })

      const result = await enrollmentStore.getEnrollment(testDid)
      expect(result?.enrollmentRkey).toBe('did:web:stratos.example.com')
    })

    it('should update the active flag via updateEnrollment', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zFayeValentine1',
        active: true,
      })

      await enrollmentStore.updateEnrollment(testDid, { active: false })
      expect((await enrollmentStore.getEnrollment(testDid))?.active).toBe(false)

      await enrollmentStore.updateEnrollment(testDid, { active: true })
      expect((await enrollmentStore.getEnrollment(testDid))?.active).toBe(true)
    })

    it('should update signingKeyDid via updateEnrollment', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zEdward1',
        active: true,
      })

      await enrollmentStore.updateEnrollment(testDid, {
        signingKeyDid: 'did:key:zEinRotated2',
      })

      const result = await enrollmentStore.getEnrollment(testDid)
      expect(result?.signingKeyDid).toBe('did:key:zEinRotated2')
    })

    it('should update pdsEndpoint without affecting enrollmentRkey', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        pdsEndpoint: 'https://old.pds.com',
        signingKeyDid: 'did:key:zPunchBebop1',
        active: true,
        enrollmentRkey: 'did:web:stratos.example.com',
      })

      await enrollmentStore.updateEnrollment(testDid, {
        pdsEndpoint: 'https://new.pds.com',
      })

      const result = await enrollmentStore.getEnrollment(testDid)
      expect(result?.pdsEndpoint).toBe('https://new.pds.com')
      expect(result?.enrollmentRkey).toBe('did:web:stratos.example.com')
    })

    it('should default isService to false for user enrollments', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        pdsEndpoint: 'https://pds.example.com',
        signingKeyDid: 'did:key:zUserKeyBebop1',
        active: true,
      })

      const result = await enrollmentStore.getEnrollment(testDid)
      expect(result?.isService).toBe(false)
    })

    it('should round-trip a service enrollment with NULL pdsEndpoint', async () => {
      const serviceDid = 'did:web:nerv.example.com'
      await enrollmentStore.enroll({
        did: serviceDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: serviceDid,
        active: true,
        boundaries: ['leadership'],
      })
      await enrollmentStore.updateEnrollment(serviceDid, { isService: true })

      const result = await enrollmentStore.getEnrollment(serviceDid)
      expect(result?.isService).toBe(true)
      expect(result?.pdsEndpoint).toBeUndefined()
      expect(result?.signingKeyDid).toBe(serviceDid)
      expect(await enrollmentStore.getBoundaries(serviceDid)).toContain(
        'leadership',
      )

      await enrollmentStore.unenroll(serviceDid)
    })

    it('should default custody to stratos and leave repoHost undefined when omitted', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zReiAyanami1',
        active: true,
      })

      const result = await enrollmentStore.getEnrollment(testDid)
      expect(result?.custody).toBe('stratos')
      expect(result?.repoHost).toBeUndefined()
    })

    it('should persist explicit pds custody and repoHost on enroll', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zAsukaLangley1',
        active: true,
        custody: 'pds',
        repoHost: 'https://pds.nerv.example.com',
      })

      const result = await enrollmentStore.getEnrollment(testDid)
      expect(result?.custody).toBe('pds')
      expect(result?.repoHost).toBe('https://pds.nerv.example.com')
    })

    it('should overwrite custody and repoHost on re-enroll via onConflictDoUpdate', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zMisatoKatsuragi1',
        active: true,
        custody: 'stratos',
      })
      expect((await enrollmentStore.getEnrollment(testDid))?.custody).toBe(
        'stratos',
      )

      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zMisatoKatsuragi2',
        active: true,
        custody: 'pds',
        repoHost: 'https://pds.nerv.example.com',
      })

      const result = await enrollmentStore.getEnrollment(testDid)
      expect(result?.custody).toBe('pds')
      expect(result?.repoHost).toBe('https://pds.nerv.example.com')
    })

    it('should reset custody to stratos and repoHost to undefined when a re-enroll omits them', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zShinjiIkari1',
        active: true,
        custody: 'pds',
        repoHost: 'https://pds.nerv.example.com',
      })

      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zShinjiIkari2',
        active: true,
      })

      const result = await enrollmentStore.getEnrollment(testDid)
      expect(result?.custody).toBe('stratos')
      expect(result?.repoHost).toBeUndefined()
    })

    it('should update custody independently of repoHost via updateEnrollment', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zKaworuNagisa1',
        active: true,
        custody: 'stratos',
      })

      await enrollmentStore.updateEnrollment(testDid, { custody: 'pds' })
      const afterCustody = await enrollmentStore.getEnrollment(testDid)
      expect(afterCustody?.custody).toBe('pds')
      expect(afterCustody?.repoHost).toBeUndefined()

      await enrollmentStore.updateEnrollment(testDid, {
        repoHost: 'https://pds.nerv.example.com',
      })
      const afterRepoHost = await enrollmentStore.getEnrollment(testDid)
      expect(afterRepoHost?.custody).toBe('pds')
      expect(afterRepoHost?.repoHost).toBe('https://pds.nerv.example.com')
    })

    it('should round-trip a truthy capabilityVerdict through enroll and getEnrollment', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zRitsukoAkagi1',
        active: true,
        capabilityVerdict: 'capable',
      })

      const result = await enrollmentStore.getEnrollment(testDid)
      expect(result?.capabilityVerdict).toBe('capable')
    })

    it('should leave capabilityVerdict undefined when omitted from enroll', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zRitsukoAkagi2',
        active: true,
      })

      const result = await enrollmentStore.getEnrollment(testDid)
      expect(result?.capabilityVerdict).toBeUndefined()
    })

    it('should round-trip an unknown capabilityVerdict, distinct from not-capable and absent', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zRitsukoAkagi3',
        active: true,
        capabilityVerdict: 'unknown',
      })

      const result = await enrollmentStore.getEnrollment(testDid)
      expect(result?.capabilityVerdict).toBe('unknown')
      expect(result?.capabilityVerdict).not.toBe('not-capable')
    })

    it('should overwrite capabilityVerdict on re-enroll via onConflictDoUpdate', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zMakotoHyuga1',
        active: true,
        capabilityVerdict: 'capable',
      })

      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zMakotoHyuga2',
        active: true,
        capabilityVerdict: 'not-capable',
      })

      const result = await enrollmentStore.getEnrollment(testDid)
      expect(result?.capabilityVerdict).toBe('not-capable')
    })

    it('should update capabilityVerdict without disturbing custody or repoHost', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zPenPenSama1',
        active: true,
        custody: 'pds',
        repoHost: 'https://pds.nerv.example.com',
      })

      await enrollmentStore.updateEnrollment(testDid, {
        capabilityVerdict: 'capable',
      })

      const result = await enrollmentStore.getEnrollment(testDid)
      expect(result?.capabilityVerdict).toBe('capable')
      expect(result?.custody).toBe('pds')
      expect(result?.repoHost).toBe('https://pds.nerv.example.com')
    })

    it('should clear repoHost to undefined via updateEnrollment when explicitly passed undefined', async () => {
      // A future custody migration (MM-10) needs to clear repoHost when it
      // moves a user off 'pds' custody, not just leave it at the old endpoint.
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zPenPenSama2',
        active: true,
        custody: 'pds',
        repoHost: 'https://pds.nerv.example.com',
      })

      await enrollmentStore.updateEnrollment(testDid, {
        custody: 'stratos',
        repoHost: undefined,
      })

      const result = await enrollmentStore.getEnrollment(testDid)
      expect(result?.custody).toBe('stratos')
      expect(result?.repoHost).toBeUndefined()
    })

    it('should keep existing boundaries when enroll is called with an empty boundaries array', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zPenPenBebop1',
        active: true,
        boundaries: ['leftover'],
      })
      expect(await enrollmentStore.getBoundaries(testDid)).toContain('leftover')

      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zPenPenBebop1',
        active: true,
        boundaries: [],
      })

      expect(await enrollmentStore.getBoundaries(testDid)).toContain('leftover')
    })

    it('should list only service enrollments via listServiceEnrollments', async () => {
      const serviceDid = 'did:web:nerv.example.com'
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        pdsEndpoint: 'https://pds.example.com',
        signingKeyDid: 'did:key:zUserKeyBebop2',
        active: true,
      })
      await enrollmentStore.enroll({
        did: serviceDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: serviceDid,
        active: true,
      })
      await enrollmentStore.updateEnrollment(serviceDid, { isService: true })

      const services = await enrollmentStore.listServiceEnrollments()
      expect(services.map((e) => e.did)).toEqual([serviceDid])
      expect(services[0].isService).toBe(true)

      await enrollmentStore.unenroll(serviceDid)
    })
  })

  describe('PgPdsSyncQueueStore', () => {
    let queue: PgPdsSyncQueueStore

    beforeEach(() => {
      queue = new PgPdsSyncQueueStore(serviceDb)
    })

    afterEach(async () => {
      await cleanupClient`DELETE FROM "enrollment_pds_sync"`
    })

    it('upsertPending creates a due pending job', async () => {
      await queue.upsertPending(testDid)

      const jobs = await queue.list(100)
      expect(jobs).toHaveLength(1)
      expect(jobs[0].did).toBe(testDid)
      expect(jobs[0].status).toBe('pending')
      expect(jobs[0].attemptCount).toBe(0)
      expect(jobs[0].lastError).toBeNull()

      const claimed = await queue.claimDue(
        new Date().toISOString(),
        new Date(Date.now() + 60_000).toISOString(),
      )
      expect(claimed?.did).toBe(testDid)
    })

    it('upsertPending revives a failed job and preserves firstQueuedAt', async () => {
      await queue.upsertPending(testDid)
      const [before] = await queue.list(100)

      await queue.markFailed(testDid, 1, 'invalid_grant')
      const [failed] = await queue.list(100)
      expect(failed.status).toBe('failed')

      await queue.upsertPending(testDid)
      const [revived] = await queue.list(100)
      expect(revived.status).toBe('pending')
      expect(revived.attemptCount).toBe(0)
      expect(revived.lastError).toBeNull()
      expect(revived.firstQueuedAt).toBe(before.firstQueuedAt)
    })

    it('claimDue honors nextAttemptAt and excludes failed jobs', async () => {
      const future = new Date(Date.now() + 60_000).toISOString()
      await queue.upsertPending(testDid)
      await queue.markRetry(testDid, 1, 1, future, 'ECONNREFUSED')
      await queue.upsertPending(testDid2)
      await queue.markFailed(testDid2, 1, 'invalid_grant')

      const leaseUntil = new Date(Date.now() + 180_000).toISOString()
      await expect(
        queue.claimDue(new Date().toISOString(), leaseUntil),
      ).resolves.toBeUndefined()

      const dueLater = await queue.claimDue(
        new Date(Date.now() + 120_000).toISOString(),
        leaseUntil,
      )
      expect(dueLater?.did).toBe(testDid)
      expect(dueLater?.attemptCount).toBe(1)
      expect(dueLater?.lastError).toBe('ECONNREFUSED')
    })

    it('retains a cancelled generation and revives it monotonically', async () => {
      await queue.upsertPending(testDid)
      const cancelled = await queue.markCancelled(testDid)
      expect(await queue.list(100)).toHaveLength(0)
      await expect(
        queue.markCancelled('did:plc:unknown'),
      ).resolves.toBeUndefined()
      const revived = await queue.upsertPending(testDid)
      expect(revived).toBeGreaterThan(cancelled!)
      await expect(queue.markCompleted(testDid, cancelled!)).resolves.toBe(
        false,
      )
      expect((await queue.list(100))[0]).toMatchObject({
        status: 'pending',
        generation: revived,
      })
    })

    it('list bounds each page and pages forward from the given key', async () => {
      await queue.upsertPending(testDid)
      await new Promise((resolve) => setTimeout(resolve, 5))
      await queue.upsertPending(testDid2)

      const first = await queue.list(1)
      expect(first.map((j) => j.did)).toEqual([testDid])

      const second = await queue.list(1, {
        firstQueuedAt: first[0].firstQueuedAt,
        did: first[0].did,
      })
      expect(second.map((j) => j.did)).toEqual([testDid2])
    })
  })

  describe('PgLabelStore', () => {
    const nerv = 'did:plc:nerv-moderation'
    const rei = 'did:plc:rei'
    let store: PgLabelStore

    function recordLabel(
      rkey: string,
      overrides: Partial<NewLabel> = {},
    ): NewLabel {
      return {
        subjectKey: `at://${rei}/zone.stratos.feed.post/${rkey}`,
        subjectKind: 'record',
        val: '!takedown',
        neg: false,
        boundaries: ['eva-pilots'],
        createdBy: nerv,
        createdAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
      }
    }

    beforeEach(async () => {
      await cleanupClient`TRUNCATE "moderation_label" RESTART IDENTITY`
      store = new PgLabelStore(serviceDb)
    })

    afterEach(async () => {
      await cleanupClient`TRUNCATE "moderation_label" RESTART IDENTITY`
    })

    it('assigns increasing seq values starting from an empty table', async () => {
      const first = await store.appendIfLatest(null, recordLabel('a'))
      const second = await store.appendIfLatest(null, recordLabel('b'))
      const third = await store.appendIfLatest(null, recordLabel('c'))
      if (
        first.kind !== 'appended' ||
        second.kind !== 'appended' ||
        third.kind !== 'appended'
      ) {
        throw new Error('expected every append to succeed')
      }
      expect(first.label.seq).toBe(1)
      expect(second.label.seq).toBe(2)
      expect(third.label.seq).toBe(3)
    })

    it('round trips a record label with every optional field present', async () => {
      const input = recordLabel('full', {
        cid: 'bafyreigendou',
        neg: true,
        ref: 'ticket-0042',
        boundaries: ['zeta', 'alpha', 'zeta', 'mid', 'alpha'],
      })
      const result = await store.appendIfLatest(null, input)
      if (result.kind !== 'appended') throw new Error('expected append')

      const expected = {
        ...input,
        seq: result.label.seq,
        boundaries: ['alpha', 'mid', 'zeta'],
      }
      expect(result.label).toEqual(expected)
      expect(await store.latestForSubject(input.subjectKey)).toEqual(expected)
    })

    it('round trips a record label with optional fields absent', async () => {
      const input = recordLabel('bare')
      const result = await store.appendIfLatest(null, input)
      if (result.kind !== 'appended') throw new Error('expected append')

      const stored = await store.latestForSubject(input.subjectKey)
      expect(stored).toEqual({ ...input, seq: result.label.seq })
      expect(stored?.cid).toBeUndefined()
      expect(stored?.ref).toBeUndefined()
      expect(stored?.neg).toBe(false)
    })

    it('round trips an account label with an empty boundary list', async () => {
      const input: NewLabel = {
        subjectKey: rei,
        subjectKind: 'account',
        val: '!takedown',
        neg: false,
        boundaries: [],
        createdBy: nerv,
        createdAt: '2026-01-02T00:00:00.000Z',
      }
      const result = await store.appendIfLatest(null, input)
      if (result.kind !== 'appended') throw new Error('expected append')
      expect(await store.latestForSubject(rei)).toEqual({
        ...input,
        seq: result.label.seq,
      })
    })

    it('latestForSubject returns the highest seq and ignores other keys', async () => {
      const target = recordLabel('target')
      const first = await store.appendIfLatest(null, target)
      if (first.kind !== 'appended') throw new Error('expected append')
      await store.appendIfLatest(null, recordLabel('other'))
      const retraction = await store.appendIfLatest(
        first.label.seq,
        recordLabel('target', { neg: true }),
      )
      if (retraction.kind !== 'appended') throw new Error('expected append')
      await store.appendIfLatest(null, recordLabel('another'))

      const latest = await store.latestForSubject(target.subjectKey)
      expect(latest?.seq).toBe(retraction.label.seq)
      expect(latest?.neg).toBe(true)
      expect(latest?.subjectKey).toBe(target.subjectKey)
    })

    it('latestForSubject returns undefined for an unknown key', async () => {
      await store.appendIfLatest(null, recordLabel('known'))
      expect(
        await store.latestForSubject(`at://${rei}/zone.stratos.feed.post/nope`),
      ).toBeUndefined()
    })

    async function seedLabels(count: number): Promise<number[]> {
      const seqs: number[] = []
      for (let index = 0; index < count; index++) {
        const result = await store.appendIfLatest(
          null,
          recordLabel(`row-${index}`),
        )
        if (result.kind !== 'appended') throw new Error('expected append')
        seqs.push(result.label.seq)
      }
      return seqs
    }

    it('listFrom treats the cursor as exclusive and returns ascending rows', async () => {
      const seqs = await seedLabels(5)
      const rows = await store.listFrom({ cursor: seqs[1], limit: 100 })
      expect(rows.map((row) => row.seq)).toEqual(seqs.slice(2))
    })

    it('listFrom respects limit', async () => {
      const seqs = await seedLabels(5)
      const rows = await store.listFrom({ limit: 2 })
      expect(rows.map((row) => row.seq)).toEqual(seqs.slice(0, 2))
    })

    it('listFrom starts from the beginning without a cursor', async () => {
      const seqs = await seedLabels(3)
      const rows = await store.listFrom({ limit: 100 })
      expect(rows.map((row) => row.seq)).toEqual(seqs)
    })

    it('listFrom pages to the end returning every label exactly once', async () => {
      const seqs = await seedLabels(7)
      const seen: number[] = []
      let cursor: number | undefined
      for (let pageCount = 0; pageCount < 20; pageCount++) {
        const page = await store.listFrom({ cursor, limit: 3 })
        if (page.length === 0) break
        seen.push(...page.map((row) => row.seq))
        cursor = page[page.length - 1].seq
      }
      expect(seen).toEqual(seqs)
    })

    it('appendIfLatest returns stale with the current latest and writes nothing', async () => {
      const first = await store.appendIfLatest(null, recordLabel('ikari'))
      if (first.kind !== 'appended') throw new Error('expected append')

      const outcome = await store.appendIfLatest(
        first.label.seq + 99,
        recordLabel('ikari', { neg: true }),
      )
      expect(outcome).toEqual({ kind: 'stale', latest: first.label })
      expect(await store.listFrom({ limit: 100 })).toEqual([first.label])
    })

    it('appendIfLatest treats null as right for a new subject and stale once a label exists', async () => {
      const label = recordLabel('asuka')
      const first = await store.appendIfLatest(null, label)
      expect(first.kind).toBe('appended')

      const second = await store.appendIfLatest(null, label)
      expect(second.kind).toBe('stale')
      if (second.kind === 'stale') {
        expect(second.latest?.subjectKey).toBe(label.subjectKey)
      }
      expect(await store.listFrom({ limit: 100 })).toHaveLength(1)
    })

    it('appendIfLatest returns stale with no latest when a label is expected but none exists', async () => {
      const outcome = await store.appendIfLatest(5, recordLabel('ghost'))
      expect(outcome).toEqual({ kind: 'stale', latest: undefined })
      expect(await store.listFrom({ limit: 100 })).toEqual([])
    })

    describe('across separate connections', () => {
      const connectionCount = 20
      let connections: ServicePgDb[]
      let stores: PgLabelStore[]

      beforeEach(() => {
        connections = Array.from({ length: connectionCount }, () =>
          createServicePgDb(pgUrl),
        )
        stores = connections.map((connection) => new PgLabelStore(connection))
      })

      afterEach(async () => {
        await Promise.all(connections.map((c) => closeServicePgDb(c)))
      })

      it('appends identical concurrent requests once, over 10 rounds', async () => {
        for (let round = 0; round < 10; round++) {
          const label = recordLabel(`same-${round}`)
          const outcomes = await Promise.all(
            stores.map((s) => s.appendIfLatest(null, label)),
          )
          expect(outcomes.filter((o) => o.kind === 'appended')).toHaveLength(1)
          expect(outcomes.filter((o) => o.kind === 'stale')).toHaveLength(19)

          const rows = (await store.listFrom({ limit: 1000 })).filter(
            (row) => row.subjectKey === label.subjectKey,
          )
          expect(rows).toHaveLength(1)
        }
      })

      it('assigns unique ascending seq values to 50 distinct subjects', async () => {
        const outcomes = await Promise.all(
          Array.from({ length: 50 }, (_, index) =>
            stores[index % connectionCount].appendIfLatest(
              null,
              recordLabel(`distinct-${index}`),
            ),
          ),
        )
        const seqs = outcomes.map((outcome) => {
          if (outcome.kind !== 'appended') throw new Error('expected append')
          return outcome.label.seq
        })
        expect(new Set(seqs).size).toBe(50)

        const listedSeqs = (await store.listFrom({ limit: 1000 })).map(
          (row) => row.seq,
        )
        expect(listedSeqs).toHaveLength(50)
        expect(listedSeqs).toEqual([...listedSeqs].sort((a, b) => a - b))
        expect(new Set(listedSeqs)).toEqual(new Set(seqs))
      })
    })

    it('migration is idempotent and keeps rows', async () => {
      const first = await store.appendIfLatest(null, recordLabel('keep'))
      if (first.kind !== 'appended') throw new Error('expected append')

      await migrateServicePgDb(serviceDb)
      await migrateServicePgDb(serviceDb)

      expect(await store.listFrom({ limit: 100 })).toEqual([first.label])
    })
  })
})
