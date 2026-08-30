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
  })

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
})
