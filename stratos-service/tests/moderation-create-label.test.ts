import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import axios, { type AxiosResponse } from 'axios'
import express from 'express'
import { decode } from '@atcute/cbor'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import { createServiceJwt, Server as XrpcServer } from '@atproto/xrpc-server'
import {
  computeCid,
  encodeRecord,
  parseCid,
  RECORD_SUBJECT_TYPE,
  stratosLexicons,
  type BoundaryCatalogStore,
  type BoundaryDefinition,
  type LabelStore,
  type StoredLabel,
} from '@northskysocial/stratos-core'

import { StratosActorStore } from '../src/context.js'
import { RepoWriteLocks } from '../src/shared/repo-write-lock.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from '../src/db'
import {
  registerModerationHandlers,
  SqliteLabelStore,
} from '../src/features/moderation/index.js'
import {
  AuditedEnrollmentStore,
  BoundaryAudit,
  migrateBoundaryAudit,
  SqliteBoundaryAuditBackend,
  sqliteAuditSql,
} from '../src/features/boundary-audit/index.js'
import { ActiveBoundaryEnrollmentStore } from '../src/features/boundary/enrollment-store.js'
import { migrateSqliteBoundaries } from '../src/features/boundary/migrate.js'
import { createSqliteBoundaryStore } from '../src/features/boundary/store.js'
import { ReservedDomainEnrollmentStore } from '../src/infra/storage/reserved-domain-enrollment-store.js'
import { SqliteEnrollmentStore } from '../src/storage/sqlite/enrollment-store.js'
import { mintSpaceCredential } from '../src/features/space-credential/minter.js'
import { createAuthVerifiers } from '../src/infra/auth/verifiers.js'
import { ADMIN_SESSION_COOKIE } from '../src/oauth/admin-routes.js'
import { SqliteAdminSessionStore } from '../src/oauth/admin-session-store.js'
import { SqliteAdminUserStore } from '../src/oauth/admin-user-store.js'
import { createMockBlobStore, createTestConfig } from './utils'
import { makeSpaceUri } from './helpers/space-uri.js'
import {
  buildSqliteMembershipStores,
  catalogDefinition,
} from './helpers/enrollment-holds.js'

const SERVICE_DID = 'did:web:stratos.test'
const CREATE_LABEL_NSID = 'zone.stratos.moderation.createLabel'
const CREATE_LABEL_PATH = `/xrpc/${CREATE_LABEL_NSID}`
const POST_COLLECTION = 'zone.stratos.feed.post'
const DOMAINS_TYPE = 'zone.stratos.boundary.defs#Domains'

const AUTHOR_DID = 'did:plc:rei-ayanami'
const ADMIN_DID = 'did:plc:gendo-ikari'
const MEMBER_DID = 'did:plc:misato-katsuragi'
const ENGINEERING = 'did:web:nerv.tokyo.jp/engineering'
const PILOTS = 'did:web:nerv.tokyo.jp/pilots'
const SECRET_TEXT = 'The Third Impact begins at dawn'

type LogFn = (obj: object | string, msg?: string) => void
type LogSpy = Mock<LogFn>

interface SeedOptions {
  stored: string[]
  claimed?: string[]
}

function bodyClaiming(boundaries: string[]) {
  return {
    $type: POST_COLLECTION,
    text: SECRET_TEXT,
    ...(boundaries.length === 0
      ? {}
      : {
          boundary: {
            $type: DOMAINS_TYPE,
            values: boundaries.map((value) => ({ value })),
          },
        }),
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

describe('zone.stratos.moderation.createLabel', () => {
  let dataDir: string
  let db: ServiceDb
  let actorStore: StratosActorStore
  let labelStore: SqliteLabelStore
  let adminSessions: SqliteAdminSessionStore
  let moderator: Secp256k1Keypair
  let stranger: Secp256k1Keypair
  let signingKey: Secp256k1Keypair
  let verifiers: ReturnType<typeof createAuthVerifiers>
  let moderatorToken: string
  let logger: Record<'debug' | 'info' | 'warn' | 'error', LogSpy>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ctx: any
  let httpServer: http.Server
  let baseUrl: string

  async function jwt(
    keypair: Secp256k1Keypair,
    lxm: string = CREATE_LABEL_NSID,
  ): Promise<string> {
    return createServiceJwt({
      iss: keypair.did(),
      aud: SERVICE_DID,
      lxm,
      keypair,
    })
  }

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-create-label-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)
    labelStore = new SqliteLabelStore(db, join(dataDir, 'service.sqlite'))
    adminSessions = new SqliteAdminSessionStore(db)
    actorStore = new StratosActorStore({
      dataDir,
      blobstore: () => createMockBlobStore(),
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })

    moderator = await Secp256k1Keypair.create({ exportable: true })
    stranger = await Secp256k1Keypair.create({ exportable: true })
    signingKey = await Secp256k1Keypair.create()
    const documents = new Map(
      [moderator, stranger].map((keypair) => [
        keypair.did(),
        didDocumentFor(keypair),
      ]),
    )
    const idResolver = {
      did: { resolve: async (did: string) => documents.get(did) },
    } as unknown as IdResolver

    const cfg = createTestConfig(dataDir)
    cfg.moderationServiceDids = [moderator.did()]
    logger = {
      debug: vi.fn<LogFn>(),
      info: vi.fn<LogFn>(),
      warn: vi.fn<LogFn>(),
      error: vi.fn<LogFn>(),
    }
    verifiers = createAuthVerifiers(
      cfg.service.did,
      idResolver,
      cfg,
      { getEnrollment: async () => ({ active: true }) } as never,
      adminSessions,
      new SqliteAdminUserStore(db),
      [ADMIN_DID],
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
      labelStore,
      repoWriteLocks: new RepoWriteLocks(),
      logger,
      authVerifier: verifiers,
    }

    const server = new XrpcServer(stratosLexicons)
    registerModerationHandlers(server, ctx)
    const app = express()
    app.use(server.router)
    httpServer = app.listen(0)
    baseUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`
    moderatorToken = await jwt(moderator)
  })

  afterEach(async () => {
    ctx.repoWriteLocks.destroy()
    await new Promise((resolve) => httpServer.close(resolve))
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  function recordUri(rkey: string, did = AUTHOR_DID): string {
    return `at://${did}/${POST_COLLECTION}/${rkey}`
  }

  async function seedRecord(rkey: string, options: SeedOptions) {
    if (!(await actorStore.exists(AUTHOR_DID))) {
      await actorStore.create(AUTHOR_DID)
    }
    // The block holds the body (with its claim); the index rows come from
    // `value`, so a body can claim boundaries that differ from the stored rows.
    const body = bodyClaiming(options.claimed ?? options.stored)
    const cid = parseCid((await computeCid(body)).toString())
    await actorStore.transact(AUTHOR_DID, async (store) => {
      await store.record.putRecord({
        uri: recordUri(rkey),
        cid,
        value: bodyClaiming(options.stored),
        content: encodeRecord(body),
      })
    })
  }

  function subjectFor(rkey: string) {
    return { $type: RECORD_SUBJECT_TYPE, uri: recordUri(rkey) }
  }

  function createLabel(
    body: Record<string, unknown>,
    headers: Record<string, string> = {
      authorization: `Bearer ${moderatorToken}`,
    },
  ): Promise<AxiosResponse> {
    return axios.post(`${baseUrl}${CREATE_LABEL_PATH}`, body, {
      headers,
      validateStatus: () => true,
    })
  }

  function takedown(rkey: string, extra: Record<string, unknown> = {}) {
    return createLabel({
      subject: subjectFor(rkey),
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

  async function expectNothingWritten(rkey: string) {
    expect(await allLabels()).toEqual([])
    const status = await marker(rkey)
    expect(status === null || status.applied === false).toBe(true)
  }

  it('(a) takedown appends one label with the stored boundaries and sets the marker', async () => {
    await seedRecord('a', { stored: [ENGINEERING, PILOTS], claimed: [PILOTS] })

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
    await seedRecord('b', { stored: [ENGINEERING] })

    const res = await takedown('b')

    expect(res.status).toBe(200)
    expect(res.data.label.ref).toBeUndefined()
    expect(await marker('b')).toEqual({
      applied: true,
      ref: String(res.data.label.seq),
    })
  })

  it('(b) a takedown with an empty ref ends with the marker String(seq)', async () => {
    await seedRecord('b2', { stored: [ENGINEERING] })

    const res = await takedown('b2', { ref: '' })

    expect(res.status).toBe(200)
    expect(await marker('b2')).toEqual({
      applied: true,
      ref: String(res.data.label.seq),
    })
  })

  it('(c) a negation appends a second label, clears the marker and serves the record again', async () => {
    await seedRecord('c', { stored: [ENGINEERING] })
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
    await seedRecord('d', { stored: [ENGINEERING] })

    const first = await takedown('d', { ref: 'case-0003' })
    const second = await takedown('d', { ref: 'case-0003' })

    expect(second.status).toBe(200)
    expect(second.data).toEqual(first.data)
    expect(await allLabels()).toHaveLength(1)
  })

  it('(e) a different ref appends a new label and the marker takes the new ref', async () => {
    await seedRecord('e', { stored: [ENGINEERING] })

    await takedown('e', { ref: 'case-0004' })
    const second = await takedown('e', { ref: 'case-0005' })

    expect(second.data.label.ref).toBe('case-0005')
    expect(await allLabels()).toHaveLength(2)
    expect(await marker('e')).toEqual({ applied: true, ref: 'case-0005' })
  })

  it('(f) a negation on a never-labelled record returns {} and changes nothing', async () => {
    await seedRecord('f', { stored: [ENGINEERING] })

    const res = await takedown('f', { neg: true })

    expect(res.status).toBe(200)
    expect(res.data).toEqual({})
    await expectNothingWritten('f')
  })

  it('(f) a negation repeated after a negation returns that negation and appends nothing', async () => {
    await seedRecord('f2', { stored: [ENGINEERING] })
    await takedown('f2', { ref: 'case-0006' })
    const negation = await takedown('f2', { neg: true })

    const repeat = await takedown('f2', { neg: true })

    expect(repeat.data).toEqual(negation.data)
    expect(await allLabels()).toHaveLength(2)
    expect(await marker('f2')).toEqual({ applied: false })
  })

  describe('subject cid', () => {
    it('a hosted takedown stores the subject cid and returns it', async () => {
      await seedRecord('cid-hosted', { stored: [ENGINEERING] })
      const cid = (await computeCid(bodyClaiming([ENGINEERING]))).toString()

      const res = await createLabel({
        subject: { ...subjectFor('cid-hosted'), cid },
        val: '!takedown',
      })

      expect(res.status).toBe(200)
      expect(res.data.label.subject).toEqual({
        $type: RECORD_SUBJECT_TYPE,
        uri: recordUri('cid-hosted'),
        cid,
      })
      expect((await allLabels())[0].cid).toBe(cid)
    })

    it('a hosted takedown without a cid stores and returns none', async () => {
      await seedRecord('cid-none', { stored: [ENGINEERING] })

      const res = await takedown('cid-none')

      expect(res.status).toBe(200)
      expect(res.data.label.subject).toEqual({
        $type: RECORD_SUBJECT_TYPE,
        uri: recordUri('cid-none'),
      })
      expect(res.data.label.subject).not.toHaveProperty('cid')
      expect((await allLabels())[0].cid).toBeUndefined()
    })
  })

  describe('(g) rejected subjects', () => {
    it('unknown rkey is SubjectNotFound', async () => {
      await seedRecord('g', { stored: [ENGINEERING] })

      const res = await takedown('no-such-rkey')

      expect(res.status).toBe(400)
      expect(res.data.error).toBe('SubjectNotFound')
      await expectNothingWritten('g')
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

    it('a deleted record is SubjectNotFound', async () => {
      await seedRecord('g-deleted', { stored: [ENGINEERING] })
      await actorStore.transact(AUTHOR_DID, (store) =>
        store.record.deleteRecord(recordUri('g-deleted')),
      )

      const res = await takedown('g-deleted')

      expect(res.data.error).toBe('SubjectNotFound')
      expect(await allLabels()).toEqual([])
    })

    it('a malformed URI is InvalidRequest', async () => {
      const res = await createLabel({
        subject: { $type: RECORD_SUBJECT_TYPE, uri: 'not-a-uri' },
        val: '!takedown',
      })

      expect(res.status).toBe(400)
      expect(res.data.error).toBe('InvalidRequest')
      expect(await allLabels()).toEqual([])
    })

    it('a val other than !takedown is InvalidRequest', async () => {
      await seedRecord('g-hide', { stored: [ENGINEERING] })

      const res = await createLabel({
        subject: subjectFor('g-hide'),
        val: '!hide',
      })

      expect(res.status).toBe(400)
      expect(res.data.error).toBe('InvalidRequest')
      await expectNothingWritten('g-hide')
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
        latestTakedowns: (keys) => real.latestTakedowns(keys),
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
      await seedRecord('h1', { stored: [ENGINEERING] })
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
      await seedRecord('h2', { stored: [ENGINEERING] })
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

    it('takedown with an empty ref: marker set and non-empty, final marker is String(seq)', async () => {
      await seedRecord('h4', { stored: [ENGINEERING] })
      failNextAppend()

      const failed = await takedown('h4', { ref: '' })

      expect(failed.status).toBe(500)
      const afterFailure = await marker('h4')
      expect(afterFailure?.applied).toBe(true)
      expect(afterFailure?.ref).toBeTruthy()

      const repeat = await takedown('h4', { ref: '' })

      expect(await allLabels()).toHaveLength(1)
      expect(await marker('h4')).toEqual({
        applied: true,
        ref: String(repeat.data.label.seq),
      })
    })

    it('negation: marker stays set and the record hidden, repeat leaves exactly one negation', async () => {
      await seedRecord('h3', { stored: [ENGINEERING] })
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

    it('negation: appends that keep losing leave the marker set and the record hidden', async () => {
      await seedRecord('h5', { stored: [ENGINEERING] })
      await takedown('h5', { ref: 'case-0009' })
      const real: LabelStore = labelStore
      const runawayCap = 10
      const alwaysStale = vi.fn<LabelStore['appendIfLatest']>(async () => {
        if (alwaysStale.mock.calls.length > runawayCap) {
          throw new Error('retry loop did not stop')
        }
        return { kind: 'stale', latest: undefined }
      })
      ctx.labelStore = {
        latestForSubject: (key) => real.latestForSubject(key),
        listFrom: (opts) => real.listFrom(opts),
        headSeq: () => real.headSeq(),
        latestTakedowns: (keys) => real.latestTakedowns(keys),
        appendIfLatest: alwaysStale,
      } satisfies LabelStore

      const res = await takedown('h5', { neg: true })

      expect(res.status).toBe(500)
      expect(alwaysStale).toHaveBeenCalledTimes(3)
      expect(await marker('h5')).toEqual({ applied: true, ref: 'case-0009' })
      expect(await servedRecord('h5')).toBeNull()
      expect(await allLabels()).toHaveLength(1)
    })

    it('negation: the marker is still set when the label is appended, then cleared', async () => {
      await seedRecord('h6', { stored: [ENGINEERING] })
      await takedown('h6', { ref: 'case-0010' })
      const real: LabelStore = labelStore
      const markersAtAppend: unknown[] = []
      ctx.labelStore = {
        latestForSubject: (key) => real.latestForSubject(key),
        listFrom: (opts) => real.listFrom(opts),
        headSeq: () => real.headSeq(),
        latestTakedowns: (keys) => real.latestTakedowns(keys),
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

  describe('(h2) appends that keep losing', () => {
    it('gives up after three attempts with a 500, one warning and no label', async () => {
      await seedRecord('h3', { stored: [ENGINEERING] })
      const real: LabelStore = labelStore
      // The cap turns a runaway retry loop into a failed assertion, not a hang.
      const runawayCap = 10
      const alwaysStale = vi.fn<LabelStore['appendIfLatest']>(async () => {
        if (alwaysStale.mock.calls.length > runawayCap) {
          throw new Error('retry loop did not stop')
        }
        return { kind: 'stale', latest: undefined }
      })
      ctx.labelStore = {
        latestForSubject: (key) => real.latestForSubject(key),
        listFrom: (opts) => real.listFrom(opts),
        headSeq: () => real.headSeq(),
        latestTakedowns: (keys) => real.latestTakedowns(keys),
        appendIfLatest: alwaysStale,
      } satisfies LabelStore

      const res = await takedown('h3', { ref: 'case-0030' })

      expect(res.status).toBe(500)
      expect(alwaysStale).toHaveBeenCalledTimes(3)
      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(logger.warn.mock.calls[0][0]).toMatchObject({
        subject: recordUri('h3'),
      })
      expect(await allLabels()).toEqual([])
    })
  })

  describe('(i) callers other than an allowlisted moderation service', () => {
    async function expectRejected(headers: Record<string, string>) {
      await seedRecord('i', { stored: [ENGINEERING] })

      const res = await createLabel(
        { subject: subjectFor('i'), val: '!takedown', ref: 'case-0009' },
        headers,
      )

      expect(res.status).toBe(401)
      await expectNothingWritten('i')
    }

    it('rejects a service JWT whose issuer is not allowlisted', async () => {
      await expectRejected({ authorization: `Bearer ${await jwt(stranger)}` })
    })

    it('rejects an allowlisted issuer with the wrong lxm', async () => {
      const token = await jwt(moderator, 'zone.stratos.moderation.queryLabels')
      await expectRejected({ authorization: `Bearer ${token}` })
    })

    it('rejects an OAuth user', async () => {
      const headers = { authorization: `Bearer ${MEMBER_DID}` }
      const asUser = await verifiers.standard({
        req: { headers, url: CREATE_LABEL_PATH },
      } as never)
      expect(asUser.credentials.did).toBe(MEMBER_DID)

      await expectRejected(headers)
    })

    it('rejects an admin session', async () => {
      const sessionKey = await adminSessions.create(ADMIN_DID, 60_000)
      const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${sessionKey}` }
      const asAdmin = await verifiers.admin({
        req: { headers },
        res: { setHeader: vi.fn() },
      } as never)
      expect(asAdmin.credentials.did).toBe(ADMIN_DID)

      await expectRejected(headers)
    })

    it('rejects a space credential', async () => {
      const { credential } = await mintSpaceCredential({
        signingKey,
        issuerDid: SERVICE_DID,
        spaceUri: makeSpaceUri(SERVICE_DID, 'zone.stratos.space.feed', 'nerv'),
        ttlSeconds: 7_200,
      })
      const headers = { authorization: `Bearer ${credential}` }
      const asCredential = await verifiers.spaceCredential({
        req: { headers, url: CREATE_LABEL_PATH, method: 'POST' },
        res: { setHeader: vi.fn() },
      } as never)
      expect(asCredential.credentials.type).toBe('space-credential')

      await expectRejected(headers)
    })
  })

  describe('(j) logging', () => {
    function appendEvents() {
      return logger.info.mock.calls
        .map(([entry]) => entry as Record<string, unknown>)
        .filter((entry) => 'callerDid' in entry)
    }

    it('an append logs one event with the five fields', async () => {
      await seedRecord('j', { stored: [ENGINEERING] })

      const res = await takedown('j', { ref: 'case-0010' })

      expect(appendEvents()).toEqual([
        {
          subject: recordUri('j'),
          callerDid: moderator.did(),
          neg: false,
          ref: 'case-0010',
          seq: res.data.label.seq,
        },
      ])
    })

    it('a return-existing logs no event', async () => {
      await seedRecord('j2', { stored: [ENGINEERING] })
      await takedown('j2', { ref: 'case-0011' })
      expect(appendEvents()).toHaveLength(1)

      await takedown('j2', { ref: 'case-0011' })

      expect(appendEvents()).toHaveLength(1)
    })

    it('no logged value contains the record text or the token', async () => {
      await seedRecord('j3', { stored: [ENGINEERING] })
      await takedown('j3', { ref: 'case-0012' })
      await takedown('j3', { neg: true })

      const everything = JSON.stringify(
        Object.values(logger).flatMap((spy) => spy.mock.calls),
      )

      expect(everything).not.toContain(SECRET_TEXT)
      expect(everything).not.toContain(moderatorToken)
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
        latestTakedowns: (keys) => real.latestTakedowns(keys),
        appendIfLatest: (expected, label) =>
          real.appendIfLatest(expected, label),
      } satisfies LabelStore
    }

    it('identical takedowns append once and both carry the same label', async () => {
      await seedRecord('k1', { stored: [ENGINEERING] })
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

    it('takedowns with different refs append twice and the marker follows the latest', async () => {
      await seedRecord('k2', { stored: [ENGINEERING] })
      holdFirstTwoReads()

      const [left, right] = await Promise.all([
        takedown('k2', { ref: 'case-0014' }),
        takedown('k2', { ref: 'case-0015' }),
      ])

      expect([left.status, right.status]).toEqual([200, 200])
      const labels = await allLabels()
      expect(labels).toHaveLength(2)
      expect(await marker('k2')).toEqual({
        applied: true,
        ref: labels[labels.length - 1].ref,
      })
    })
  })

  describe('(l) a hosted record with no boundary rows', () => {
    it('still takes the record down, stores [] and warns once', async () => {
      await seedRecord('l', { stored: [] })

      const res = await takedown('l', { ref: 'case-0016' })

      expect(res.status).toBe(200)
      const labels = await allLabels()
      expect(labels).toHaveLength(1)
      expect(labels[0].boundaries).toEqual([])
      expect(await marker('l')).toEqual({ applied: true, ref: 'case-0016' })
      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(logger.warn.mock.calls)).toContain(recordUri('l'))
    })
  })

  describe('reconcile cap', () => {
    it('gives up after a bounded number of rounds, warns once and still answers', async () => {
      await seedRecord('cap', { stored: [ENGINEERING] })
      const real: LabelStore = labelStore
      let appended = false
      let drift = 0
      ctx.labelStore = {
        latestForSubject: async (key) => {
          // Yield to timers so a runaway loop times the test out instead of starving it.
          await new Promise((resolve) => setTimeout(resolve, 0))
          const latest = await real.latestForSubject(key)
          return appended && latest
            ? { ...latest, seq: latest.seq + ++drift }
            : latest
        },
        listFrom: (opts) => real.listFrom(opts),
        headSeq: () => real.headSeq(),
        latestTakedowns: (keys) => real.latestTakedowns(keys),
        appendIfLatest: async (expected, label) => {
          const result = await real.appendIfLatest(expected, label)
          appended = true
          return result
        },
      } satisfies LabelStore

      const res = await takedown('cap', { ref: 'case-0100' })

      expect(res.status).toBe(200)
      expect(res.data.label.ref).toBe('case-0100')
      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(logger.warn.mock.calls[0][0]).toEqual({
        subject: recordUri('cap'),
      })
    })
  })

  describe('reconcile cap marker writes', () => {
    const MAX_RECONCILE_ROUNDS = 5
    const EARLY_MARKER_WRITES = 1

    it('writes the marker once early and once per reconcile round', async () => {
      await seedRecord('cap-writes', { stored: [ENGINEERING] })
      const real: LabelStore = labelStore
      let appended = false
      let drift = 0
      ctx.labelStore = {
        latestForSubject: async (key) => {
          const latest = await real.latestForSubject(key)
          return appended && latest
            ? { ...latest, seq: latest.seq + ++drift }
            : latest
        },
        listFrom: (opts) => real.listFrom(opts),
        headSeq: () => real.headSeq(),
        latestTakedowns: (keys) => real.latestTakedowns(keys),
        appendIfLatest: async (expected, label) => {
          const result = await real.appendIfLatest(expected, label)
          appended = true
          return result
        },
      } satisfies LabelStore

      let markerWrites = 0
      const realTransact = actorStore.transact.bind(actorStore)
      vi.spyOn(actorStore, 'transact').mockImplementation((did, fn) =>
        realTransact(did, (store) => {
          const realUpdate = store.record.updateRecordTakedown.bind(
            store.record,
          )
          store.record.updateRecordTakedown = (uri, takedown) => {
            markerWrites++
            return realUpdate(uri, takedown)
          }
          return fn(store)
        }),
      )

      const res = await takedown('cap-writes', { ref: 'case-0101' })

      expect(res.status).toBe(200)
      expect(markerWrites).toBe(MAX_RECONCILE_ROUNDS + EARLY_MARKER_WRITES)
    })
  })

  describe('space-form record subjects', () => {
    const SPACE_TYPE = 'zone.stratos.space.feed'
    const ASUKA_DID = 'did:plc:asuka'
    const SHINJI_DID = 'did:plc:shinji-ikari'
    const TOKYO3_BOUNDARY = `${SERVICE_DID}/tokyo-3`
    const GEOFRONT = `${SERVICE_DID}/geofront`
    const SEELE_DID = 'did:web:seele.example'
    // Known and held on purpose, so only the authority check can reject it.
    const SEELE_BOUNDARY = `${SEELE_DID}/tokyo-3`
    let members: ActiveBoundaryEnrollmentStore
    let catalog: BoundaryCatalogStore

    async function enrollMember(did: string, boundaries: string[]) {
      await members.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        active: true,
        signingKeyDid: 'did:key:zTest',
        boundaries,
        custody: 'pds',
      })
    }

    function spaceRecordUri(
      options: {
        authority?: string
        skey?: string
        author?: string
        rkey?: string
      } = {},
    ): string {
      const {
        authority = SERVICE_DID,
        skey = 'tokyo-3',
        author = ASUKA_DID,
        rkey = 'eva-unit-02',
      } = options
      return `${makeSpaceUri(authority, SPACE_TYPE, skey)}/${author}/${POST_COLLECTION}/${rkey}`
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
      ;({ members, catalog } = await buildSqliteMembershipStores(db, {
        serviceDid: SERVICE_DID,
        reservedBoundary: `${SERVICE_DID}/general`,
        boundaries: [TOKYO3_BOUNDARY, GEOFRONT],
      }))
      // Room ids are unique, and this one would collide with tokyo-3's.
      await catalog.create({
        ...catalogDefinition(SEELE_BOUNDARY),
        roomId: 'seele-tokyo-3',
      })
      ctx.enrollmentStore = members
      ctx.boundaryStore = catalog
      await enrollMember(ASUKA_DID, [TOKYO3_BOUNDARY, SEELE_BOUNDARY])
      // Would pass if the authority were checked in place of the author.
      await enrollMember(SERVICE_DID, [TOKYO3_BOUNDARY, GEOFRONT])
    })

    it('(m) a takedown for a member appends one label with the mapped boundary and writes no marker', async () => {
      const uri = spaceRecordUri()
      const existedBefore = await actorStore.exists(ASUKA_DID)

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
      expect(await actorStore.exists(ASUKA_DID)).toBe(existedBefore)
      expect(await actorStore.exists(AUTHOR_DID)).toBe(false)
    })

    it('(n) a space of another authority is InvalidRequest and appends nothing', async () => {
      const res = await spaceLabel(spaceRecordUri({ authority: SEELE_DID }))

      expect(res.status).toBe(400)
      expect(res.data.error).toBe('InvalidRequest')
      expect(await allLabels()).toEqual([])
    })

    it('(n) a foreign authority is rejected by the authority check, not the boundary lookup', async () => {
      const res = await spaceLabel(spaceRecordUri({ authority: SEELE_DID }))

      expect(res.status).toBe(400)
      expect(res.data.message).toContain('space is not owned by this service')
    })

    it('a space takedown with a cid stores and returns it; without one, none', async () => {
      const cid = (await computeCid(bodyClaiming([TOKYO3_BOUNDARY]))).toString()
      const withCid = spaceRecordUri({ rkey: 'with-cid' })

      const pinned = await createLabel({
        subject: { $type: RECORD_SUBJECT_TYPE, uri: withCid, cid },
        val: '!takedown',
      })
      const bare = await spaceLabel(spaceRecordUri({ rkey: 'no-cid' }))

      expect(pinned.status).toBe(200)
      expect(pinned.data.label.subject).toEqual({
        $type: RECORD_SUBJECT_TYPE,
        uri: withCid,
        cid,
      })
      expect(bare.data.label.subject).not.toHaveProperty('cid')
      const stored = await allLabels()
      expect(stored.map((label) => label.cid)).toEqual([cid, undefined])
    })

    it('(o) an unknown boundary is InvalidRequest and appends nothing', async () => {
      // Written past the catalog check, which would refuse an unknown boundary.
      await new SqliteEnrollmentStore(db).setBoundaries(ASUKA_DID, [
        `${SERVICE_DID}/lilith`,
      ])

      const res = await spaceLabel(spaceRecordUri({ skey: 'lilith' }))

      expect(res.status).toBe(400)
      expect(res.data.error).toBe('InvalidRequest')
      expect(await allLabels()).toEqual([])
    })

    it('(p) a non-member author is InvalidRequest and appends nothing', async () => {
      const res = await spaceLabel(spaceRecordUri({ author: SHINJI_DID }))

      expect(res.status).toBe(400)
      expect(res.data.error).toBe('InvalidRequest')
      expect(await allLabels()).toEqual([])
    })

    it('(p) an author outside the boundary is rejected even when the authority is a member', async () => {
      await enrollMember(SHINJI_DID, [GEOFRONT])

      const res = await spaceLabel(spaceRecordUri({ author: SHINJI_DID }))

      expect(res.status).toBe(400)
      expect(res.data.error).toBe('InvalidRequest')
      expect(await allLabels()).toEqual([])
    })

    it('(q) a negation appends after the author left the boundary', async () => {
      const uri = spaceRecordUri()
      await spaceLabel(uri, { ref: 'case-0201' })
      await members.setBoundaries(ASUKA_DID, [])

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

    describe('(r) the negation exemption has limits', () => {
      it('a non-member negation with no takedown in force is InvalidRequest', async () => {
        const res = await spaceLabel(spaceRecordUri({ author: SHINJI_DID }), {
          neg: true,
        })

        expect(res.status).toBe(400)
        expect(res.data.error).toBe('InvalidRequest')
        expect(await allLabels()).toEqual([])
      })

      it('a non-member negation after a negation is InvalidRequest', async () => {
        const uri = spaceRecordUri()
        await spaceLabel(uri, { ref: 'case-0202' })
        await spaceLabel(uri, { neg: true })
        await members.setBoundaries(ASUKA_DID, [])

        const res = await spaceLabel(uri, { neg: true })

        expect(res.status).toBe(400)
        expect(await allLabels()).toHaveLength(2)
      })

      it('a negation for another authority is InvalidRequest even with a takedown in force', async () => {
        const uri = spaceRecordUri({ authority: SEELE_DID })
        await labelStore.appendIfLatest(null, {
          subjectKey: uri,
          subjectKind: 'record',
          val: '!takedown',
          neg: false,
          boundaries: [SEELE_BOUNDARY],
          createdBy: moderator.did(),
          createdAt: new Date().toISOString(),
        })

        const res = await spaceLabel(uri, { neg: true })

        expect(res.status).toBe(400)
        expect(res.data.error).toBe('InvalidRequest')
        expect(await allLabels()).toHaveLength(1)
      })

      it('a negation whose boundary is no longer known is InvalidRequest', async () => {
        const uri = spaceRecordUri()
        await spaceLabel(uri, { ref: 'case-0203' })
        const lookUp = catalog.get.bind(catalog)
        vi.spyOn(catalog, 'get').mockImplementation(async (boundary) =>
          boundary === TOKYO3_BOUNDARY ? null : lookUp(boundary),
        )

        const res = await spaceLabel(uri, { neg: true })

        expect(res.status).toBe(400)
        expect(res.data.error).toBe('InvalidRequest')
        expect(await allLabels()).toHaveLength(1)
      })
    })

    describe('(s) repeats and negations', () => {
      it('the same ref twice gives one row and the first label', async () => {
        const uri = spaceRecordUri()
        const first = await spaceLabel(uri, { ref: 'case-0204' })

        const second = await spaceLabel(uri, { ref: 'case-0204' })

        expect(second.status).toBe(200)
        expect(second.data).toEqual(first.data)
        expect(await allLabels()).toHaveLength(1)
      })

      it('a different ref gives a second row', async () => {
        const uri = spaceRecordUri()
        await spaceLabel(uri, { ref: 'case-0205' })

        const second = await spaceLabel(uri, { ref: 'case-0206' })

        expect(second.data.label.ref).toBe('case-0206')
        expect(await allLabels()).toHaveLength(2)
      })

      it('a negation on a never-labelled subject returns {} and appends nothing', async () => {
        const res = await spaceLabel(spaceRecordUri(), { neg: true })

        expect(res.status).toBe(200)
        expect(res.data).toEqual({})
        expect(await allLabels()).toEqual([])
      })
    })

    describe('(t) logging', () => {
      function appendEvents() {
        return logger.info.mock.calls
          .map(([entry]) => entry as Record<string, unknown>)
          .filter((entry) => 'callerDid' in entry)
      }

      it('logs one event per appended label and none for a repeat', async () => {
        const uri = spaceRecordUri()

        const first = await spaceLabel(uri, { ref: 'case-0207' })
        await spaceLabel(uri, { ref: 'case-0207' })
        const negation = await spaceLabel(uri, { neg: true })

        expect(appendEvents()).toEqual([
          {
            subject: uri,
            callerDid: moderator.did(),
            neg: false,
            ref: 'case-0207',
            seq: first.data.label.seq,
          },
          {
            subject: uri,
            callerDid: moderator.did(),
            neg: true,
            ref: undefined,
            seq: negation.data.label.seq,
          },
        ])
      })
    })

    describe('a hosted author', () => {
      it('a member enrolled with no custody field is InvalidRequest and appends nothing', async () => {
        await members.enroll({
          did: ASUKA_DID,
          enrolledAt: new Date().toISOString(),
          active: true,
          signingKeyDid: 'did:key:zTest',
          boundaries: [TOKYO3_BOUNDARY],
        })

        const res = await spaceLabel(spaceRecordUri())

        expect(res.status).toBe(400)
        expect(res.data.error).toBe('InvalidRequest')
        expect(res.data.message).toContain('repo-form URI')
        expect(await allLabels()).toEqual([])
      })

      it('reads the enrollment once per request', async () => {
        const getEnrollment = vi.spyOn(members, 'getEnrollment')

        const res = await spaceLabel(spaceRecordUri())

        expect(res.status).toBe(200)
        expect(getEnrollment).toHaveBeenCalledTimes(1)
      })
    })
  })
  describe('space-form record subjects with the production enrollment and catalog stores', () => {
    const SPACE_TYPE = 'zone.stratos.space.feed'
    const ASUKA_DID = 'did:plc:asuka'
    const SHINJI_DID = 'did:plc:shinji-ikari'
    const KAWORU_DID = 'did:plc:kaworu-nagisa'
    const TOKYO3_BOUNDARY = `${SERVICE_DID}/tokyo-3`
    const RESERVED_BOUNDARY = `${SERVICE_DID}/general`
    let members: ActiveBoundaryEnrollmentStore
    let catalog: ReturnType<typeof createSqliteBoundaryStore>

    function definitionOf(boundary: string): BoundaryDefinition {
      const now = new Date().toISOString()
      return {
        boundary,
        roomId: boundary.slice(boundary.lastIndexOf('/') + 1),
        displayName: boundary,
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

    function spaceRecordUri(author: string, skey = 'tokyo-3'): string {
      return `${makeSpaceUri(SERVICE_DID, SPACE_TYPE, skey)}/${author}/${POST_COLLECTION}/eva-unit-02`
    }

    function spaceLabel(uri: string): Promise<AxiosResponse> {
      return createLabel({
        subject: { $type: RECORD_SUBJECT_TYPE, uri },
        val: '!takedown',
        ref: 'case-0300',
      })
    }

    // The same decorator chain createStorageContext builds for SQLite.
    beforeEach(async () => {
      await migrateSqliteBoundaries(db)
      catalog = createSqliteBoundaryStore(db)
      await catalog.create(definitionOf(TOKYO3_BOUNDARY))
      await migrateBoundaryAudit(sqliteAuditSql(db))
      const audit = new BoundaryAudit(
        SERVICE_DID,
        new SqliteBoundaryAuditBackend(db),
      )
      const auditKey = await Secp256k1Keypair.create()
      audit.setSigner({
        publicKey: auditKey.did(),
        sign: (bytes) => auditKey.sign(bytes),
      })
      members = new ActiveBoundaryEnrollmentStore(
        new ReservedDomainEnrollmentStore(
          new AuditedEnrollmentStore(new SqliteEnrollmentStore(db), audit),
          RESERVED_BOUNDARY,
        ),
        catalog,
      )
      ctx.enrollmentStore = members
      ctx.boundaryStore = catalog
      await members.enroll({
        did: ASUKA_DID,
        enrolledAt: new Date().toISOString(),
        active: true,
        signingKeyDid: 'did:key:zTest',
        boundaries: [TOKYO3_BOUNDARY],
        custody: 'pds',
      })
    })

    it('(m) a member takedown appends one label with the mapped boundary', async () => {
      const uri = spaceRecordUri(ASUKA_DID)

      const res = await spaceLabel(uri)

      expect(res.status).toBe(200)
      const labels = await allLabels()
      expect(labels).toHaveLength(1)
      expect(labels[0]).toMatchObject({
        subjectKey: uri,
        subjectKind: 'record',
        boundaries: [TOKYO3_BOUNDARY],
        ref: 'case-0300',
        createdBy: moderator.did(),
      })
    })

    it('(o) a boundary missing from the catalog is InvalidRequest and appends nothing', async () => {
      const res = await spaceLabel(spaceRecordUri(ASUKA_DID, 'lilith'))

      expect(res.status).toBe(400)
      expect(res.data.error).toBe('InvalidRequest')
      expect(res.data.message).toBe('unknown boundary')
      expect(await allLabels()).toEqual([])
    })

    it('(p) a non-member author is InvalidRequest and appends nothing', async () => {
      const res = await spaceLabel(spaceRecordUri(SHINJI_DID))

      expect(res.status).toBe(400)
      expect(res.data.error).toBe('InvalidRequest')
      expect(res.data.message).toBe('author is not a member of the boundary')
      expect(await allLabels()).toEqual([])
    })

    describe('the reserved all-members boundary', () => {
      beforeEach(async () => {
        await catalog.create(definitionOf(RESERVED_BOUNDARY))
      })

      it('(v1) a never-enrolled author is InvalidRequest and appends nothing', async () => {
        const res = await spaceLabel(spaceRecordUri(SHINJI_DID, 'general'))

        expect(res.status).toBe(400)
        expect(res.data.error).toBe('InvalidRequest')
        expect(res.data.message).toBe('author is not a member of the boundary')
        expect(await allLabels()).toEqual([])
      })

      it('(v2) a deactivated author holding the boundary is InvalidRequest', async () => {
        await members.updateEnrollment(ASUKA_DID, { active: false })

        const res = await spaceLabel(spaceRecordUri(ASUKA_DID))

        expect(res.status).toBe(400)
        expect(res.data.error).toBe('InvalidRequest')
        expect(await allLabels()).toEqual([])
      })

      it('(v3) active enrolled authors take the label, one persisted before the reserved domain was forced in', async () => {
        const legacyRow = new SqliteEnrollmentStore(db)
        await legacyRow.enroll({
          did: KAWORU_DID,
          enrolledAt: new Date().toISOString(),
          active: true,
          signingKeyDid: 'did:key:zTest',
          boundaries: [TOKYO3_BOUNDARY],
          custody: 'pds',
        })

        const enrolled = await spaceLabel(spaceRecordUri(ASUKA_DID, 'general'))
        const legacy = await spaceLabel(spaceRecordUri(KAWORU_DID, 'general'))

        expect([enrolled.status, legacy.status]).toEqual([200, 200])
        expect(await allLabels()).toHaveLength(2)
      })

      it('(v4) a negation appends after the author was deactivated', async () => {
        const uri = spaceRecordUri(ASUKA_DID)
        await spaceLabel(uri)
        await members.updateEnrollment(ASUKA_DID, { active: false })

        const res = await createLabel({
          subject: { $type: RECORD_SUBJECT_TYPE, uri },
          val: '!takedown',
          neg: true,
        })

        expect(res.status).toBe(200)
        expect(await allLabels()).toHaveLength(2)
      })
    })

    describe('custody of the author', () => {
      async function enrollWithCustody(
        did: string,
        custody: 'stratos' | 'pds' | undefined,
      ) {
        await members.enroll({
          did,
          enrolledAt: new Date().toISOString(),
          active: true,
          signingKeyDid: 'did:key:zTest',
          boundaries: [TOKYO3_BOUNDARY],
          ...(custody ? { custody } : {}),
        })
      }

      async function seedTakedown(uri: string) {
        await labelStore.appendIfLatest(null, {
          subjectKey: uri,
          subjectKind: 'record',
          val: '!takedown',
          neg: false,
          boundaries: [TOKYO3_BOUNDARY],
          createdBy: moderator.did(),
          createdAt: new Date().toISOString(),
        })
      }

      function negation(uri: string): Promise<AxiosResponse> {
        return createLabel({
          subject: { $type: RECORD_SUBJECT_TYPE, uri },
          val: '!takedown',
          neg: true,
        })
      }

      it('(w1) a takedown for a member with stratos custody is InvalidRequest and appends nothing', async () => {
        await enrollWithCustody(SHINJI_DID, 'stratos')

        const res = await spaceLabel(spaceRecordUri(SHINJI_DID))

        expect(res.status).toBe(400)
        expect(res.data.error).toBe('InvalidRequest')
        expect(res.data.message).toContain('repo-form URI')
        expect(await allLabels()).toEqual([])
      })

      it('(w2) a member enrolled with no custody is held by Stratos and rejected', async () => {
        await enrollWithCustody(SHINJI_DID, undefined)

        const res = await spaceLabel(spaceRecordUri(SHINJI_DID))

        expect(res.status).toBe(400)
        expect(res.data.message).toContain('repo-form URI')
        expect(await allLabels()).toEqual([])
      })

      it('(w3) a member with pds custody still appends one label', async () => {
        await enrollWithCustody(SHINJI_DID, 'pds')

        const res = await spaceLabel(spaceRecordUri(SHINJI_DID))

        expect(res.status).toBe(200)
        expect(await allLabels()).toHaveLength(1)
      })

      it('(w4) a negation for a stratos-custody author is rejected while a takedown is in force', async () => {
        await enrollWithCustody(SHINJI_DID, 'stratos')
        const uri = spaceRecordUri(SHINJI_DID)
        await seedTakedown(uri)

        const res = await negation(uri)

        expect(res.status).toBe(400)
        expect(res.data.message).toContain('repo-form URI')
        expect(await allLabels()).toHaveLength(1)
      })

      it('(w5) an author with no enrollment row is not rejected for custody', async () => {
        const uri = spaceRecordUri(SHINJI_DID)
        const withoutTakedown = await negation(uri)
        await seedTakedown(uri)

        const withTakedown = await negation(uri)

        expect(withoutTakedown.status).toBe(400)
        expect(withoutTakedown.data.message).toBe(
          'author is not a member of the boundary',
        )
        expect(withTakedown.status).toBe(200)
        expect(await allLabels()).toHaveLength(2)
      })

      it('(w6) reads the enrollment once per request', async () => {
        const reads = vi.spyOn(members, 'getEnrollment')

        const res = await spaceLabel(spaceRecordUri(ASUKA_DID))

        expect(res.status).toBe(200)
        expect(reads).toHaveBeenCalledTimes(1)
      })
    })
  })
})
