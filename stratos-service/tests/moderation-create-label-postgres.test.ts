/**
 * createLabel against the Postgres stores. Mirrors the SQLite handler cases in
 * moderation-create-label.test.ts so both backends hold the same contract.
 *
 * Requires Docker; starts its own PostgreSQL container.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest'
import http from 'node:http'
import axios, { type AxiosResponse } from 'axios'
import express from 'express'
import postgres from 'postgres'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import { createServiceJwt, Server as XrpcServer } from '@atproto/xrpc-server'
import {
  computeCid,
  parseCid,
  RECORD_SUBJECT_TYPE,
  stratosLexicons,
  type BoundaryCatalogStore,
  type BoundaryDefinition,
  type LabelStore,
  type NewLabel,
  type StoredLabel,
} from '@northskysocial/stratos-core'

import type { AppContext } from '../src/context-types.js'
import type { ActorStore } from '../src/actor-store-types.js'
import { RepoWriteLocks } from '../src/shared/repo-write-lock.js'
import {
  closeServicePgDb,
  createServicePgDb,
  migrateServicePgDb,
  type ServicePgDb,
} from '../src/db/pg.js'
import {
  PgEnrollmentStoreWriter,
  PostgresActorStore,
} from '../src/infra/storage/postgres/index.js'
import {
  PgLabelStore,
  registerModerationHandlers,
} from '../src/features/moderation/index.js'
import { createPgBoundaryStore } from '../src/features/boundary/store.js'
import { migratePgBoundaries } from '../src/features/boundary/migrate.js'
import { ActiveBoundaryEnrollmentStore } from '../src/features/boundary/enrollment-store.js'
import { ReservedDomainEnrollmentStore } from '../src/infra/storage/reserved-domain-enrollment-store.js'
import { createAuthVerifiers } from '../src/infra/auth/verifiers.js'
import { PgAdminSessionStore, PgAdminUserStore } from '../src/oauth/index.js'
import { createTestConfig } from './utils'
import {
  cborToRecord,
  createMockBlobStoreCreator,
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'
import { makeSpaceUri } from './helpers/space-uri.js'

const SERVICE_DID = 'did:web:stratos.test'
const CREATE_LABEL_NSID = 'zone.stratos.moderation.createLabel'
const POST_COLLECTION = 'zone.stratos.feed.post'
const DOMAINS_TYPE = 'zone.stratos.boundary.defs#Domains'
const SPACE_TYPE = 'zone.stratos.space.feed'

const AUTHOR_DID = 'did:plc:rei-ayanami'
const ASUKA_DID = 'did:plc:asuka'
const SHINJI_DID = 'did:plc:shinji-ikari'
const KAWORU_DID = 'did:plc:kaworu-nagisa'
const ENGINEERING = 'did:web:nerv.tokyo.jp/engineering'
const PILOTS = 'did:web:nerv.tokyo.jp/pilots'
const TOKYO3_BOUNDARY = `${SERVICE_DID}/tokyo-3`
const RESERVED_BOUNDARY = `${SERVICE_DID}/general`
const SECRET_TEXT = 'The Third Impact begins at dawn'

type LogFn = (obj: object | string, msg?: string) => void

function bodyClaiming(boundaries: string[]) {
  return {
    $type: POST_COLLECTION,
    text: SECRET_TEXT,
    boundary: {
      $type: DOMAINS_TYPE,
      values: boundaries.map((value) => ({ value })),
    },
  }
}

function didDocumentFor(keypair: Secp256k1Keypair) {
  return {
    id: keypair.did(),
    verificationMethod: [
      {
        id: `${keypair.did()}#key`,
        type: 'Multikey',
        controller: keypair.did(),
        publicKeyMultibase: keypair.did().slice('did:key:'.length),
      },
    ],
  }
}

function definitionOf(boundary: string): BoundaryDefinition {
  const name = boundary.slice(boundary.lastIndexOf('/') + 1)
  const now = new Date().toISOString()
  return {
    boundary,
    roomId: name,
    displayName: name,
    description: '',
    listed: false,
    joinable: false,
    autoEnroll: false,
    appAccess: 'open',
    clientIds: [],
    status: 'active',
    createdAt: now,
    updatedAt: now,
    revision: 1,
  }
}

describe('zone.stratos.moderation.createLabel on Postgres', () => {
  let pgUrl: string
  let serviceDb: ServicePgDb
  let cleanupClient: postgres.Sql
  let actorStore: ActorStore
  let labelStore: PgLabelStore
  let boundaryStore: BoundaryCatalogStore
  let enrollmentStore: ActiveBoundaryEnrollmentStore
  let moderator: Secp256k1Keypair
  let moderatorToken: string
  let logger: Record<'debug' | 'info' | 'warn' | 'error', Mock<LogFn>>
  let ctx: AppContext
  let httpServer: http.Server
  let baseUrl: string

  beforeAll(async () => {
    pgUrl = await startPostgresContainer()
    cleanupClient = postgres(pgUrl, { max: 1 })
    serviceDb = createServicePgDb(pgUrl)
    await migrateServicePgDb(serviceDb)
    await migratePgBoundaries(serviceDb)
    boundaryStore = createPgBoundaryStore(serviceDb)
    for (const boundary of [
      ENGINEERING,
      PILOTS,
      TOKYO3_BOUNDARY,
      `${SERVICE_DID}/geofront`,
    ]) {
      await boundaryStore.create(definitionOf(boundary))
    }
    labelStore = new PgLabelStore(serviceDb)
    enrollmentStore = new ActiveBoundaryEnrollmentStore(
      new ReservedDomainEnrollmentStore(
        new PgEnrollmentStoreWriter(serviceDb),
        RESERVED_BOUNDARY,
      ),
      boundaryStore,
    )
    actorStore = new PostgresActorStore({
      connectionString: pgUrl,
      blobstore: createMockBlobStoreCreator(),
      cborToRecord,
    })
  }, 120_000)

  afterAll(async () => {
    await cleanupClient.end()
    await closeServicePgDb(serviceDb)
    await stopPostgresContainer()
  }, 60_000)

  beforeEach(async () => {
    await cleanupClient`TRUNCATE "moderation_label" RESTART IDENTITY`
    await cleanupClient`DELETE FROM enrollment_boundary`
    await cleanupClient`DELETE FROM enrollment`

    moderator = await Secp256k1Keypair.create({ exportable: true })
    const signingKey = await Secp256k1Keypair.create()
    const documents = new Map([[moderator.did(), didDocumentFor(moderator)]])
    const idResolver = {
      did: { resolve: async (did: string) => documents.get(did) },
    } as unknown as IdResolver
    const cfg = createTestConfig('/tmp/stratos-create-label-postgres')
    cfg.moderationServiceDids = [moderator.did()]
    logger = {
      debug: vi.fn<LogFn>(),
      info: vi.fn<LogFn>(),
      warn: vi.fn<LogFn>(),
      error: vi.fn<LogFn>(),
    }
    const verifiers = createAuthVerifiers(
      cfg.service.did,
      idResolver,
      cfg,
      { getEnrollment: async () => ({ active: true }) } as never,
      new PgAdminSessionStore(serviceDb),
      new PgAdminUserStore(serviceDb),
      [],
      {} as never,
      undefined,
      true,
      signingKey,
      undefined,
      logger,
    )
    ctx = {
      cfg,
      serviceDid: SERVICE_DID,
      actorStore,
      enrollmentStore,
      boundaryStore,
      labelStore,
      repoWriteLocks: new RepoWriteLocks(),
      logger,
      authVerifier: verifiers,
    } as unknown as AppContext

    const server = new XrpcServer(stratosLexicons)
    registerModerationHandlers(server, ctx)
    const app = express()
    app.use(server.router)
    httpServer = app.listen(0)
    baseUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`
    moderatorToken = await createServiceJwt({
      iss: moderator.did(),
      aud: SERVICE_DID,
      lxm: CREATE_LABEL_NSID,
      keypair: moderator,
    })
  })

  afterEach(async () => {
    ctx.repoWriteLocks.destroy()
    await new Promise((resolve) => httpServer.close(resolve))
    for (const did of [AUTHOR_DID, ASUKA_DID, SHINJI_DID]) {
      try {
        await actorStore.destroy(did)
      } catch {
        // never created in this test
      }
    }
  })

  function recordUri(rkey: string, did = AUTHOR_DID): string {
    return `at://${did}/${POST_COLLECTION}/${rkey}`
  }

  async function seedRecord(rkey: string, stored: string[]) {
    if (!(await actorStore.exists(AUTHOR_DID))) {
      await actorStore.create(AUTHOR_DID)
    }
    const body = bodyClaiming(stored)
    const cid = parseCid((await computeCid(body)).toString())
    await actorStore.transact(AUTHOR_DID, async (store) => {
      await store.record.putRecord({
        uri: recordUri(rkey),
        cid,
        value: body,
        content: new TextEncoder().encode(JSON.stringify(body)),
      })
    })
  }

  async function enrollMember(
    did: string,
    boundaries: string[],
    custody: 'stratos' | 'pds' = 'pds',
  ) {
    await enrollmentStore.enroll({
      did,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:zTest',
      boundaries,
      custody,
    })
  }

  function createLabel(body: Record<string, unknown>): Promise<AxiosResponse> {
    return axios.post(`${baseUrl}/xrpc/${CREATE_LABEL_NSID}`, body, {
      headers: { authorization: `Bearer ${moderatorToken}` },
      validateStatus: () => true,
    })
  }

  function takedown(rkey: string, extra: Record<string, unknown> = {}) {
    return createLabel({
      subject: { $type: RECORD_SUBJECT_TYPE, uri: recordUri(rkey) },
      val: '!takedown',
      ...extra,
    })
  }

  async function marker(rkey: string) {
    return actorStore.read(AUTHOR_DID, (store) =>
      store.record.getRecordTakedownStatus(recordUri(rkey)),
    )
  }

  async function servedRecord(rkey: string) {
    return actorStore.read(AUTHOR_DID, (store) =>
      store.record.getRecord(recordUri(rkey), null),
    )
  }

  async function allLabels(): Promise<StoredLabel[]> {
    return labelStore.listFrom({ limit: 100 })
  }

  describe('hosted record subjects', () => {
    it('(a) takedown appends one label with the stored boundaries and sets the marker', async () => {
      await seedRecord('a', [ENGINEERING, PILOTS])

      const res = await takedown('a', { ref: 'case-0001' })

      expect(res.status).toBe(200)
      expect(res.data.label).toEqual({
        seq: expect.any(Number),
        subject: { $type: RECORD_SUBJECT_TYPE, uri: recordUri('a') },
        val: '!takedown',
        neg: false,
        ref: 'case-0001',
        createdAt: expect.any(String),
      })
      const labels = await allLabels()
      expect(labels).toHaveLength(1)
      expect(labels[0]).toMatchObject({
        seq: res.data.label.seq,
        subjectKey: recordUri('a'),
        boundaries: [ENGINEERING, PILOTS],
        createdBy: moderator.did(),
      })
      expect(await marker('a')).toEqual({ applied: true, ref: 'case-0001' })
      expect(await servedRecord('a')).toBeNull()
    })

    it('(b) a takedown with no ref ends with the marker String(seq)', async () => {
      await seedRecord('b', [ENGINEERING])

      const res = await takedown('b')

      expect(res.status).toBe(200)
      expect(res.data.label.ref).toBeUndefined()
      expect(await marker('b')).toEqual({
        applied: true,
        ref: String(res.data.label.seq),
      })
    })

    it('(b) a takedown with an empty ref ends with the marker String(seq)', async () => {
      await seedRecord('b2', [ENGINEERING])

      const res = await takedown('b2', { ref: '' })

      expect(res.status).toBe(200)
      expect(await marker('b2')).toEqual({
        applied: true,
        ref: String(res.data.label.seq),
      })
    })

    it('(c) a negation appends a second label, clears the marker and serves the record again', async () => {
      await seedRecord('c', [ENGINEERING])
      const first = await takedown('c', { ref: 'case-0002' })

      const res = await takedown('c', { neg: true })

      expect(res.status).toBe(200)
      expect(res.data.label).toMatchObject({ neg: true, val: '!takedown' })
      expect(res.data.label.seq).toBeGreaterThan(first.data.label.seq)
      expect(await allLabels()).toHaveLength(2)
      expect(await marker('c')).toEqual({ applied: false })
      expect(await servedRecord('c')).not.toBeNull()
    })

    it('(d) the same ref twice appends once and returns the first label', async () => {
      await seedRecord('d', [ENGINEERING])

      const first = await takedown('d', { ref: 'case-0003' })
      const second = await takedown('d', { ref: 'case-0003' })

      expect(second.status).toBe(200)
      expect(second.data).toEqual(first.data)
      expect(await allLabels()).toHaveLength(1)
    })

    it('(e) a different ref appends a new label and the marker takes the new ref', async () => {
      await seedRecord('e', [ENGINEERING])

      const first = await takedown('e', { ref: 'case-0004' })
      const second = await takedown('e', { ref: 'case-0005' })

      expect(second.data.label.ref).toBe('case-0005')
      expect(second.data.label.seq).toBeGreaterThan(first.data.label.seq)
      expect(await allLabels()).toHaveLength(2)
      expect(await marker('e')).toEqual({ applied: true, ref: 'case-0005' })
    })

    it('(f) a negation on a never-labelled record returns {} and changes nothing', async () => {
      await seedRecord('f', [ENGINEERING])

      const res = await takedown('f', { neg: true })

      expect(res.status).toBe(200)
      expect(res.data).toEqual({})
      expect(await allLabels()).toEqual([])
      expect(await marker('f')).toEqual({ applied: false })
    })

    describe('(g) rejected subjects', () => {
      it('unknown rkey is SubjectNotFound', async () => {
        await seedRecord('g', [ENGINEERING])

        const res = await takedown('no-such-rkey')

        expect(res.status).toBe(400)
        expect(res.data.error).toBe('SubjectNotFound')
        expect(await allLabels()).toEqual([])
        expect(await marker('g')).toEqual({ applied: false })
      })

      it('unknown author DID is SubjectNotFound', async () => {
        const res = await createLabel({
          subject: {
            $type: RECORD_SUBJECT_TYPE,
            uri: recordUri('g', 'did:plc:kaworu-nagisa'),
          },
          val: '!takedown',
        })

        expect(res.data.error).toBe('SubjectNotFound')
        expect(await allLabels()).toEqual([])
      })
    })

    describe('(h) a failed label write', () => {
      function failNextAppend(): void {
        const real: LabelStore = labelStore
        let failed = false
        ctx.labelStore = {
          latestForSubject: (key) => real.latestForSubject(key),
          listFrom: (opts) => real.listFrom(opts),
          headSeq: () => real.headSeq(),
          appendIfLatest: async (expected, label) => {
            if (!failed) {
              failed = true
              throw new Error('label table unavailable')
            }
            return real.appendIfLatest(expected, label)
          },
        } satisfies LabelStore
      }

      it('takedown with a ref: marker already set, repeat leaves one label', async () => {
        await seedRecord('h1', [ENGINEERING])
        failNextAppend()

        const failed = await takedown('h1', { ref: 'case-0007' })

        expect(failed.status).toBe(500)
        expect(await marker('h1')).toEqual({ applied: true, ref: 'case-0007' })
        expect(await allLabels()).toEqual([])

        const repeat = await takedown('h1', { ref: 'case-0007' })

        expect(repeat.status).toBe(200)
        expect(await allLabels()).toHaveLength(1)
        expect(await marker('h1')).toEqual({ applied: true, ref: 'case-0007' })
      })

      it('takedown without a ref: marker set, final marker is String(seq)', async () => {
        await seedRecord('h2', [ENGINEERING])
        failNextAppend()

        const failed = await takedown('h2')

        expect(failed.status).toBe(500)
        const afterFailure = await marker('h2')
        expect(afterFailure?.applied).toBe(true)
        expect(afterFailure?.ref).toBeTruthy()
        expect(await allLabels()).toEqual([])

        const repeat = await takedown('h2')

        expect(await allLabels()).toHaveLength(1)
        expect(await marker('h2')).toEqual({
          applied: true,
          ref: String(repeat.data.label.seq),
        })
      })

      it('negation: marker stays set and the record hidden, repeat leaves exactly one negation', async () => {
        await seedRecord('h3', [ENGINEERING])
        await takedown('h3', { ref: 'case-0008' })
        failNextAppend()

        const failed = await takedown('h3', { neg: true })

        expect(failed.status).toBe(500)
        expect(await marker('h3')).toEqual({ applied: true, ref: 'case-0008' })
        expect(await servedRecord('h3')).toBeNull()
        const afterFailure = await allLabels()
        expect(afterFailure.map((label) => label.neg)).toEqual([false])

        const repeat = await takedown('h3', { neg: true })

        expect(repeat.status).toBe(200)
        const labels = await allLabels()
        expect(labels.map((label) => label.neg)).toEqual([false, true])
        expect(await marker('h3')).toEqual({ applied: false })
        expect(await servedRecord('h3')).not.toBeNull()
      })

      it('negation: the marker is still set when the label is appended, then cleared', async () => {
        await seedRecord('h6', [ENGINEERING])
        await takedown('h6', { ref: 'case-0010' })
        const real: LabelStore = labelStore
        const markersAtAppend: unknown[] = []
        ctx.labelStore = {
          latestForSubject: (key) => real.latestForSubject(key),
          listFrom: (opts) => real.listFrom(opts),
          headSeq: () => real.headSeq(),
          appendIfLatest: async (expected, label) => {
            markersAtAppend.push(await marker('h6'))
            return real.appendIfLatest(expected, label)
          },
        } satisfies LabelStore

        const res = await takedown('h6', { neg: true })

        expect(res.status).toBe(200)
        expect(markersAtAppend).toEqual([{ applied: true, ref: 'case-0010' }])
        expect(await marker('h6')).toEqual({ applied: false })
      })
    })

    describe('(k) concurrent requests', () => {
      // Both requests read the subject's latest label before either appends,
      // so one append is guaranteed to go stale.
      function holdFirstTwoReads(): void {
        const real: LabelStore = labelStore
        let reads = 0
        let release: () => void = () => {}
        const bothRead = new Promise<void>((resolve) => (release = resolve))
        ctx.labelStore = {
          latestForSubject: async (key) => {
            const latest = await real.latestForSubject(key)
            if (reads < 2) {
              reads++
              if (reads === 2) release()
              await bothRead
            }
            return latest
          },
          listFrom: (opts) => real.listFrom(opts),
          headSeq: () => real.headSeq(),
          appendIfLatest: (expected, label) =>
            real.appendIfLatest(expected, label),
        } satisfies LabelStore
      }

      it('identical takedowns append once and both carry the same label', async () => {
        await seedRecord('k1', [ENGINEERING])
        holdFirstTwoReads()

        const [left, right] = await Promise.all([
          takedown('k1', { ref: 'case-0013' }),
          takedown('k1', { ref: 'case-0013' }),
        ])

        expect([left.status, right.status]).toEqual([200, 200])
        expect(left.data.label).toBeDefined()
        expect(left.data).toEqual(right.data)
        expect(await allLabels()).toHaveLength(1)
      })
    })
  })

  describe('label store reads', () => {
    const subjectOf = (rkey: string) => recordUri(rkey, ASUKA_DID)

    function labelFor(
      rkey: string,
      overrides: Partial<NewLabel> = {},
    ): NewLabel {
      return {
        subjectKey: subjectOf(rkey),
        subjectKind: 'record',
        val: '!takedown',
        neg: false,
        boundaries: [PILOTS],
        createdBy: 'did:plc:nerv-moderation',
        createdAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
      }
    }

    async function appendAll(rkeys: string[]): Promise<number[]> {
      const seqs: number[] = []
      for (const rkey of rkeys) {
        const result = await labelStore.appendIfLatest(null, labelFor(rkey))
        if (result.kind !== 'appended') throw new Error('expected append')
        seqs.push(result.label.seq)
      }
      return seqs
    }

    it('returns only labels of the listed subjects, in seq order', async () => {
      const seqs = await appendAll(['eva-01', 'eva-02', 'eva-03', 'eva-04'])
      const rows = await labelStore.listFrom({
        limit: 100,
        subjects: [subjectOf('eva-03'), subjectOf('eva-01')],
      })
      expect(rows.map((row) => row.subjectKey)).toEqual([
        subjectOf('eva-01'),
        subjectOf('eva-03'),
      ])
      expect(rows.map((row) => row.seq)).toEqual([seqs[0], seqs[2]])
    })

    it('treats upTo as inclusive and cursor as exclusive', async () => {
      const seqs = await appendAll(['eva-01', 'eva-02', 'eva-03', 'eva-04'])
      const rows = await labelStore.listFrom({
        cursor: seqs[0],
        upTo: seqs[2],
        limit: 100,
      })
      expect(rows.map((row) => row.seq)).toEqual([seqs[1], seqs[2]])
    })

    it('returns nothing for an empty subjects list', async () => {
      await appendAll(['eva-01', 'eva-02'])
      expect(await labelStore.listFrom({ limit: 100, subjects: [] })).toEqual(
        [],
      )
    })

    it('behaves as before when the new options are absent', async () => {
      const seqs = await appendAll(['eva-01', 'eva-02', 'eva-03'])
      const rows = await labelStore.listFrom({ cursor: seqs[0], limit: 100 })
      expect(rows.map((row) => row.seq)).toEqual(seqs.slice(1))
    })

    it('reports 0 as the head of an empty log and the last seq afterwards', async () => {
      expect(await labelStore.headSeq()).toBe(0)
      const seqs = await appendAll(['eva-01', 'eva-02', 'eva-03'])
      expect(await labelStore.headSeq()).toBe(seqs[2])
    })

    it('reports the highest seq, not the row count, when seqs have gaps', async () => {
      const [first, second] = await appendAll(['eva-01', 'eva-02'])
      await cleanupClient`DELETE FROM "moderation_label" WHERE seq = ${first}`
      expect(await labelStore.headSeq()).toBe(second)
    })

    it('lets a cursor reader see every label while appends run, over 5 runs', async () => {
      const writerDbs = Array.from({ length: 10 }, () =>
        createServicePgDb(pgUrl),
      )
      try {
        for (let run = 0; run < 5; run++) {
          const writers = Promise.all(
            writerDbs.map(async (writerDb, index) => {
              const writerStore = new PgLabelStore(writerDb)
              let expected: number | null = null
              for (let step = 0; step < 3; step++) {
                const result = await writerStore.appendIfLatest(
                  expected,
                  labelFor(`run-${run}-pilot-${index}`, { neg: step === 1 }),
                )
                if (result.kind !== 'appended') {
                  throw new Error('expected append')
                }
                expected = result.label.seq
              }
            }),
          )

          const seen: number[] = []
          let cursor = 0
          const readPage = async (): Promise<number> => {
            const page = await labelStore.listFrom({ cursor, limit: 5 })
            seen.push(...page.map((row) => row.seq))
            if (page.length > 0) cursor = page[page.length - 1].seq
            return page.length
          }
          let writersDone = false
          void writers.then(
            () => (writersDone = true),
            () => (writersDone = true),
          )
          while (!writersDone) {
            if ((await readPage()) === 0) await new Promise(setImmediate)
          }
          await writers
          const head = await labelStore.headSeq()
          while (cursor < head) await readPage()

          const everySeq = (await labelStore.listFrom({ limit: 1000 })).map(
            (row) => row.seq,
          )
          expect(everySeq).toHaveLength(30 * (run + 1))
          expect(seen).toEqual(everySeq)
        }
      } finally {
        await Promise.all(
          writerDbs.map((writerDb) => closeServicePgDb(writerDb)),
        )
      }
    }, 60_000)
  })

  describe('space-form record subjects', () => {
    function spaceRecordUri(
      options: { skey?: string; author?: string; rkey?: string } = {},
    ): string {
      const {
        skey = 'tokyo-3',
        author = ASUKA_DID,
        rkey = 'eva-unit-02',
      } = options
      return `${makeSpaceUri(SERVICE_DID, SPACE_TYPE, skey)}/${author}/${POST_COLLECTION}/${rkey}`
    }

    function spaceLabel(
      uri: string,
      extra: Record<string, unknown> = {},
    ): Promise<AxiosResponse> {
      return createLabel({
        subject: { $type: RECORD_SUBJECT_TYPE, uri },
        val: '!takedown',
        ...extra,
      })
    }

    beforeEach(async () => {
      await enrollMember(ASUKA_DID, [TOKYO3_BOUNDARY])
    })

    it('(m) a takedown for a member appends one label with the mapped boundary and writes no marker', async () => {
      const uri = spaceRecordUri()

      const res = await spaceLabel(uri, { ref: 'case-0200' })

      expect(res.status).toBe(200)
      expect(res.data.label.subject).toEqual({
        $type: RECORD_SUBJECT_TYPE,
        uri,
      })
      const labels = await allLabels()
      expect(labels).toHaveLength(1)
      expect(labels[0]).toMatchObject({
        subjectKey: uri,
        subjectKind: 'record',
        boundaries: [TOKYO3_BOUNDARY],
        createdBy: moderator.did(),
      })
      expect(await actorStore.exists(ASUKA_DID)).toBe(false)
      expect(await actorStore.exists(AUTHOR_DID)).toBe(false)
    })

    it('(p) a non-member author is InvalidRequest and appends nothing', async () => {
      const res = await spaceLabel(spaceRecordUri({ author: SHINJI_DID }))

      expect(res.status).toBe(400)
      expect(res.data.error).toBe('InvalidRequest')
      expect(await allLabels()).toEqual([])
    })

    it('(q) a negation appends after the author left the boundary', async () => {
      const uri = spaceRecordUri()
      await spaceLabel(uri, { ref: 'case-0201' })
      await enrollmentStore.setBoundaries(ASUKA_DID, [])

      const res = await spaceLabel(uri, { neg: true })

      expect(res.status).toBe(200)
      expect(res.data.label).toMatchObject({ neg: true, subject: { uri } })
      const labels = await allLabels()
      expect(labels).toHaveLength(2)
      expect(labels[1]).toMatchObject({
        neg: true,
        boundaries: [TOKYO3_BOUNDARY],
      })
    })

    describe('the reserved all-members boundary', () => {
      beforeEach(async () => {
        await boundaryStore.create(definitionOf(RESERVED_BOUNDARY))
      })

      afterEach(async () => {
        await cleanupClient`DELETE FROM boundary_definition WHERE boundary = ${RESERVED_BOUNDARY}`
      })

      it('(v1) a never-enrolled author is InvalidRequest and appends nothing', async () => {
        const res = await spaceLabel(
          spaceRecordUri({ skey: 'general', author: SHINJI_DID }),
        )

        expect(res.status).toBe(400)
        expect(res.data.error).toBe('InvalidRequest')
        expect(await allLabels()).toEqual([])
      })

      it('(v2) a deactivated author holding the boundary is InvalidRequest', async () => {
        await enrollmentStore.updateEnrollment(ASUKA_DID, { active: false })

        const res = await spaceLabel(spaceRecordUri())

        expect(res.status).toBe(400)
        expect(res.data.error).toBe('InvalidRequest')
        expect(await allLabels()).toEqual([])
      })

      it('(v3) active enrolled authors take the label, one persisted before the reserved domain was forced in', async () => {
        await new PgEnrollmentStoreWriter(serviceDb).enroll({
          did: KAWORU_DID,
          enrolledAt: new Date().toISOString(),
          active: true,
          signingKeyDid: 'did:key:zTest',
          boundaries: [TOKYO3_BOUNDARY],
          custody: 'pds',
        })

        const enrolled = await spaceLabel(spaceRecordUri({ skey: 'general' }))
        const legacy = await spaceLabel(
          spaceRecordUri({ skey: 'general', author: KAWORU_DID }),
        )

        expect([enrolled.status, legacy.status]).toEqual([200, 200])
        expect(await allLabels()).toHaveLength(2)
      })
    })

    it('(w1) a takedown for a member with stratos custody is InvalidRequest and appends nothing', async () => {
      await enrollMember(SHINJI_DID, [TOKYO3_BOUNDARY], 'stratos')

      const res = await spaceLabel(spaceRecordUri({ author: SHINJI_DID }))

      expect(res.status).toBe(400)
      expect(res.data.error).toBe('InvalidRequest')
      expect(res.data.message).toContain('repo-form URI')
      expect(await allLabels()).toEqual([])
    })

    it('(w3) a member with pds custody still appends one label', async () => {
      await enrollMember(SHINJI_DID, [TOKYO3_BOUNDARY], 'pds')

      const res = await spaceLabel(spaceRecordUri({ author: SHINJI_DID }))

      expect(res.status).toBe(200)
      expect(await allLabels()).toHaveLength(1)
    })

    it('an unknown catalog boundary is InvalidRequest and appends nothing', async () => {
      const res = await spaceLabel(spaceRecordUri({ skey: 'lilith' }))

      expect(res.status).toBe(400)
      expect(res.data.error).toBe('InvalidRequest')
      expect(await allLabels()).toEqual([])
    })
  })
})
