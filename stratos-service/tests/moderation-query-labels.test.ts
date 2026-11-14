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
import * as fc from 'fast-check'
import express from 'express'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import { createServiceJwt, Server as XrpcServer } from '@atproto/xrpc-server'
import {
  stratosLexicons,
  type BoundaryDefinition,
  type LabelSubjectKind,
  type StoredLabel,
} from '@northskysocial/stratos-core'

import type { AppContext } from '../src/context-types.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from '../src/db'
import {
  QUERY_LABELS_METHOD,
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
import { createTestConfig } from './utils'
import { makeSpaceUri } from './helpers/space-uri.js'

const SERVICE_DID = 'did:web:stratos.test'
const QUERY_PATH = `/xrpc/${QUERY_LABELS_METHOD}`
const POST_COLLECTION = 'zone.stratos.feed.post'
const ADMIN_DID = 'did:plc:gendo-ikari'
const OAUTH_USER_DID = 'did:plc:misato-katsuragi'
const TOKYO3 = `${SERVICE_DID}/tokyo-3`
const GEOFRONT = `${SERVICE_DID}/geofront`
const RESERVED = `${SERVICE_DID}/general`

const ASUKA_DID = 'did:plc:asuka'
const SHINJI_DID = 'did:plc:shinji-ikari'
const REI_DID = 'did:plc:rei-ayanami'
const KAWORU_DID = 'did:plc:kaworu-nagisa'

type LogFn = (obj: object | string, msg?: string) => void

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

function recordUri(rkey: string): string {
  return `at://${REI_DID}/${POST_COLLECTION}/${rkey}`
}

describe('zone.stratos.moderation.queryLabels', () => {
  let dataDir: string
  let db: ServiceDb
  let labelStore: SqliteLabelStore
  let adminSessions: SqliteAdminSessionStore
  let catalog: ReturnType<typeof createSqliteBoundaryStore>
  let members: ActiveBoundaryEnrollmentStore
  let moderator: Secp256k1Keypair
  let nerv: Secp256k1Keypair
  let deactivated: Secp256k1Keypair
  let boundaryless: Secp256k1Keypair
  let unenrolled: Secp256k1Keypair
  let signingKey: Secp256k1Keypair
  let verifiers: ReturnType<typeof createAuthVerifiers>
  let logger: Record<'debug' | 'info' | 'warn' | 'error', Mock<LogFn>>
  let ctx: AppContext
  let httpServer: http.Server
  let baseUrl: string

  function jwt(keypair: Secp256k1Keypair): Promise<string> {
    return createServiceJwt({
      iss: keypair.did(),
      aud: SERVICE_DID,
      lxm: QUERY_LABELS_METHOD,
      keypair,
    })
  }

  async function bearer(keypair: Secp256k1Keypair) {
    return { authorization: `Bearer ${await jwt(keypair)}` }
  }

  async function enroll(
    did: string,
    boundaries: string[],
    options: { service?: boolean } = {},
  ) {
    await members.enroll({
      did,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:zTest',
      boundaries,
      ...(options.service ? { service: true } : {}),
    } as never)
  }

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-query-labels-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)
    labelStore = new SqliteLabelStore(db, join(dataDir, 'service.sqlite'))
    adminSessions = new SqliteAdminSessionStore(db)

    // The decorator chain createStorageContext builds for SQLite. The reserved
    // all-members domain stays out of the catalog until a test adds it, and the
    // catalog filter then drops it from every enrollment.
    await migrateSqliteBoundaries(db)
    catalog = createSqliteBoundaryStore(db)
    await catalog.create(definitionOf(TOKYO3))
    await catalog.create(definitionOf(GEOFRONT))
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
        RESERVED,
      ),
      catalog,
    )

    moderator = await Secp256k1Keypair.create({ exportable: true })
    nerv = await Secp256k1Keypair.create({ exportable: true })
    deactivated = await Secp256k1Keypair.create({ exportable: true })
    boundaryless = await Secp256k1Keypair.create({ exportable: true })
    unenrolled = await Secp256k1Keypair.create({ exportable: true })
    signingKey = await Secp256k1Keypair.create()
    const documents = new Map(
      [moderator, nerv, deactivated, boundaryless, unenrolled].map(
        (keypair) => [keypair.did(), didDocumentFor(keypair)],
      ),
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
      labelStore,
      enrollmentStore: members,
      boundaryStore: catalog,
      logger,
      authVerifier: verifiers,
    } as unknown as AppContext

    await enroll(nerv.did(), [TOKYO3], { service: true })
    await enroll(deactivated.did(), [TOKYO3], { service: true })
    await members.updateEnrollment(deactivated.did(), { active: false })
    await enroll(boundaryless.did(), [], { service: true })

    const server = new XrpcServer(stratosLexicons)
    registerModerationHandlers(server, ctx)
    const app = express()
    app.use(server.router)
    httpServer = app.listen(0)
    baseUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => httpServer.close(resolve))
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  async function append(
    subjectKey: string,
    boundaries: string[],
    options: { kind?: LabelSubjectKind; neg?: boolean } = {},
  ): Promise<StoredLabel> {
    const latest = await labelStore.latestForSubject(subjectKey)
    const result = await labelStore.appendIfLatest(latest?.seq ?? null, {
      subjectKey,
      subjectKind: options.kind ?? 'record',
      val: '!takedown',
      neg: options.neg ?? false,
      boundaries,
      createdBy: moderator.did(),
      createdAt: new Date().toISOString(),
    })
    if (result.kind !== 'appended') throw new Error('seed append lost')
    return result.label
  }

  function appendAccount(did: string): Promise<StoredLabel> {
    return append(did, [], { kind: 'account' })
  }

  function query(
    headers: Record<string, string>,
    params: Record<string, unknown> = {},
  ): Promise<AxiosResponse> {
    return axios.get(`${baseUrl}${QUERY_PATH}`, {
      headers,
      params,
      paramsSerializer: { indexes: null },
      validateStatus: () => true,
    })
  }

  function seqsOf(res: AxiosResponse): number[] {
    return (res.data.labels as Array<{ seq: number }>).map((l) => l.seq)
  }

  it('(q1) a moderation service pages through 12 labels with limit 5, each once in order', async () => {
    const appended: number[] = []
    for (let index = 0; index < 12; index++) {
      appended.push((await append(recordUri(`eva-${index}`), [GEOFRONT])).seq)
    }
    const headers = await bearer(moderator)

    const seen: number[] = []
    let cursor: string | undefined
    for (let call = 0; call < 10; call++) {
      const res = await query(headers, { limit: 5, cursor })
      expect(res.status).toBe(200)
      seen.push(...seqsOf(res))
      if (seqsOf(res).length === 0) break
      cursor = res.data.cursor
    }

    expect(seen).toEqual(appended)
  })

  describe('(q2) what a scoped service sees', () => {
    it('shows record labels sharing a boundary and hides the rest', async () => {
      const shared = await append(recordUri('shared'), [TOKYO3, GEOFRONT])
      await append(recordUri('geofront-only'), [GEOFRONT])
      await append(recordUri('unscoped'), [])

      const res = await query(await bearer(nerv))

      expect(res.status).toBe(200)
      expect(seqsOf(res)).toEqual([shared.seq])
      expect(res.data.labels[0].subject).toEqual({
        $type: 'zone.stratos.moderation.defs#recordSubject',
        uri: recordUri('shared'),
      })
    })

    it('shows an account label by the member boundaries, also after the member is deactivated', async () => {
      await enroll(ASUKA_DID, [TOKYO3])
      const label = await appendAccount(ASUKA_DID)
      const headers = await bearer(nerv)

      const active = await query(headers)
      await members.updateEnrollment(ASUKA_DID, { active: false })
      const inactive = await query(headers)

      expect(seqsOf(active)).toEqual([label.seq])
      expect(active.data.labels[0].subject).toEqual({
        $type: 'zone.stratos.moderation.defs#accountSubject',
        did: ASUKA_DID,
      })
      expect(seqsOf(inactive)).toEqual([label.seq])
    })

    it('hides an account label for a member holding only another boundary', async () => {
      await enroll(SHINJI_DID, [GEOFRONT])
      await appendAccount(SHINJI_DID)

      const res = await query(await bearer(nerv))

      expect(seqsOf(res)).toEqual([])
    })

    it('shows that same account label once the reserved domain is in the catalog', async () => {
      // Every enrollment carries the reserved all-members domain, so with it in
      // the catalog two enrolled parties always share a boundary.
      await catalog.create(definitionOf(RESERVED))
      await enroll(SHINJI_DID, [GEOFRONT])
      const label = await appendAccount(SHINJI_DID)

      const res = await query(await bearer(nerv))

      expect(seqsOf(res)).toEqual([label.seq])
    })

    it('hides an account label for a member who was never enrolled', async () => {
      await catalog.create(definitionOf(RESERVED))
      await appendAccount(KAWORU_DID)

      const res = await query(await bearer(nerv))

      expect(seqsOf(res)).toEqual([])
    })
  })

  describe('(q2b) the reserved all-members domain is active in the catalog', () => {
    beforeEach(async () => {
      await catalog.create(definitionOf(RESERVED))
    })

    it('hides the account label of a DID with no enrollment from a log and from a subjects query', async () => {
      const visible = await append(recordUri('shared'), [TOKYO3])
      await appendAccount(KAWORU_DID)
      const headers = await bearer(nerv)

      const log = await query(headers)
      const named = await query(headers, { subjects: [KAWORU_DID] })
      const unlabelled = await query(headers, { subjects: [SHINJI_DID] })

      expect(seqsOf(log)).toEqual([visible.seq])
      expect(named.status).toBe(200)
      expect(named.data).toEqual(unlabelled.data)
      expect(named.data.labels).toEqual([])
    })

    it('shows an enrolled member holding only another boundary through the reserved domain, until the member is unenrolled', async () => {
      await enroll(SHINJI_DID, [GEOFRONT])
      const label = await appendAccount(SHINJI_DID)
      const headers = await bearer(nerv)

      const active = await query(headers)
      await members.updateEnrollment(SHINJI_DID, { active: false })
      const inactive = await query(headers)
      await members.unenroll(SHINJI_DID)
      const unenrolled = await query(headers)

      expect(seqsOf(active)).toEqual([label.seq])
      expect(seqsOf(inactive)).toEqual([label.seq])
      expect(seqsOf(unenrolled)).toEqual([])
    })
  })

  describe('(q3) the cursor never stalls on invisible labels', () => {
    it('reaches a visible label behind 20 invisible ones, advancing on every call', async () => {
      for (let index = 0; index < 20; index++) {
        await append(recordUri(`hidden-${index}`), [GEOFRONT])
      }
      const visible = await append(recordUri('seen'), [TOKYO3])
      const headers = await bearer(nerv)

      const collected: number[] = []
      let cursor = '0'
      let calls = 0
      while (collected.length === 0) {
        expect(++calls).toBeLessThanOrEqual(5)
        const res = await query(headers, { limit: 5, cursor })
        expect(res.status).toBe(200)
        expect(Number(res.data.cursor)).toBeGreaterThan(Number(cursor))
        cursor = res.data.cursor
        collected.push(...seqsOf(res))
      }

      expect(collected).toEqual([visible.seq])
    })

    it('stops a scan at 1000 rows and resumes from there', async () => {
      for (let index = 0; index < 1100; index++) {
        await append(recordUri(`hidden-${index}`), [GEOFRONT])
      }
      const visible = await append(recordUri('seen'), [TOKYO3])
      const headers = await bearer(nerv)

      const first = await query(headers, { limit: 250 })
      const second = await query(headers, {
        limit: 250,
        cursor: first.data.cursor,
      })

      expect(first.data).toEqual({ cursor: '1000', labels: [] })
      expect(seqsOf(second)).toEqual([visible.seq])
    })

    it('stops at 1000 rows when the page size does not divide 1000', async () => {
      const hidden: number[] = []
      for (let index = 0; index < 1100; index++) {
        hidden.push(
          (await append(recordUri(`hidden-${index}`), [GEOFRONT])).seq,
        )
      }

      const res = await query(await bearer(nerv), { limit: 7 })

      expect(res.data).toEqual({ cursor: String(hidden[999]), labels: [] })
    })

    it('answers a log of only invisible labels with no labels and an advanced cursor', async () => {
      const last = await append(recordUri('hidden-b'), [GEOFRONT])
      await append(recordUri('hidden-a'), [])
      const head = await append(recordUri('hidden-c'), [GEOFRONT])

      const res = await query(await bearer(nerv), { limit: 5 })

      expect(res.data).toEqual({ cursor: String(head.seq), labels: [] })
      expect(head.seq).toBeGreaterThan(last.seq)
    })
  })

  describe('(q4) subjects', () => {
    it('answers an out-of-scope subject exactly like a subject with no labels', async () => {
      await append(recordUri('geofront-secret'), [GEOFRONT])
      await append(recordUri('other'), [TOKYO3])
      const headers = await bearer(nerv)

      const outOfScope = await query(headers, {
        subjects: [recordUri('geofront-secret')],
      })
      const empty = await query(headers, {
        subjects: [recordUri('never-labelled')],
      })

      expect(outOfScope.status).toBe(200)
      expect(outOfScope.data).toEqual(empty.data)
      expect(outOfScope.data.labels).toEqual([])
    })

    it('returns the labels of an in-scope subject and of an account subject', async () => {
      const inScope = await append(recordUri('tokyo-post'), [TOKYO3])
      await enroll(ASUKA_DID, [TOKYO3])
      const account = await appendAccount(ASUKA_DID)
      await append(recordUri('geofront-secret'), [GEOFRONT])

      const res = await query(await bearer(nerv), {
        subjects: [recordUri('tokyo-post'), ASUKA_DID],
      })

      expect(seqsOf(res)).toEqual([inScope.seq, account.seq])
    })
  })

  describe('(q5) callers that are rejected', () => {
    async function expectUnauthorized(headers: Record<string, string>) {
      await append(recordUri('any'), [TOKYO3])

      const res = await query(headers)

      expect(res.status).toBe(401)
      expect(res.data.labels).toBeUndefined()
    }

    it('rejects a service that is not enrolled', async () => {
      await expectUnauthorized(await bearer(unenrolled))
    })

    it('rejects a deactivated service', async () => {
      await expectUnauthorized(await bearer(deactivated))
    })

    it('rejects a service with no boundaries', async () => {
      // The reserved domain is absent from the catalog here; with it present
      // every enrollment would hold at least that boundary.
      expect(await members.getBoundaries(boundaryless.did())).toEqual([])

      await expectUnauthorized(await bearer(boundaryless))
    })

    it('rejects an OAuth user', async () => {
      const headers = { authorization: `Bearer ${OAUTH_USER_DID}` }
      const asUser = await verifiers.standard({
        req: { headers, url: QUERY_PATH },
      } as never)
      expect(asUser.credentials.did).toBe(OAUTH_USER_DID)

      await expectUnauthorized(headers)
    })

    it('rejects an admin session', async () => {
      const sessionKey = await adminSessions.create(ADMIN_DID, 60_000)
      const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${sessionKey}` }
      const asAdmin = await verifiers.admin({
        req: { headers },
        res: { setHeader: vi.fn() },
      } as never)
      expect(asAdmin.credentials.did).toBe(ADMIN_DID)

      await expectUnauthorized(headers)
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
        req: { headers, url: QUERY_PATH, method: 'GET' },
        res: { setHeader: vi.fn() },
      } as never)
      expect(asCredential.credentials.type).toBe('space-credential')

      await expectUnauthorized(headers)
    })
  })

  it('(q6) the same log gives the full view to a moderation service and the scoped view to a service', async () => {
    const shared = await append(recordUri('shared'), [TOKYO3])
    const geofront = await append(recordUri('geofront-only'), [GEOFRONT])
    const unscoped = await append(recordUri('unscoped'), [])

    const asModerator = await query(await bearer(moderator))
    const asService = await query(await bearer(nerv))

    expect(seqsOf(asModerator)).toEqual([
      shared.seq,
      geofront.seq,
      unscoped.seq,
    ])
    expect(seqsOf(asService)).toEqual([shared.seq])
  })

  describe('(q7) malformed input', () => {
    it.each(['01', '-1', 'x'])('rejects the cursor %j', async (cursor) => {
      const res = await query(await bearer(nerv), { cursor })

      expect(res.status).toBe(400)
      expect(res.data.error).toBe('InvalidRequest')
    })

    it.each(['not-a-subject', 'at://did:plc:rei-ayanami', 'did:'])(
      'rejects the subject %j',
      async (subject) => {
        const res = await query(await bearer(moderator), {
          subjects: [recordUri('fine'), subject],
        })

        expect(res.status).toBe(400)
        expect(res.data.error).toBe('InvalidRequest')
      },
    )
  })

  it('(q8) a moderation reader polling during appends never skips a label', async () => {
    const headers = await bearer(moderator)
    const appends = Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        append(recordUri(`unit-${index}`), [GEOFRONT]),
      ),
    )
    let appending = true
    void appends.finally(() => (appending = false))

    const seen: number[] = []
    let cursor = '0'
    for (let call = 0; call < 500; call++) {
      const wasAppending = appending
      const res = await query(headers, { limit: 7, cursor })
      expect(res.status).toBe(200)
      seen.push(...seqsOf(res))
      cursor = res.data.cursor
      if (!wasAppending && seqsOf(res).length === 0) break
    }

    const all = (await appends).map((label) => label.seq).sort((a, b) => a - b)
    expect(seen).toEqual(all)
  })

  it('looks up each distinct member once for enrollment and once for boundaries, not once per label', async () => {
    const memberDids = [ASUKA_DID, SHINJI_DID, KAWORU_DID]
    for (const did of memberDids) await enroll(did, [TOKYO3])
    for (let round = 0; round < 2; round++) {
      for (const did of memberDids) {
        await append(did, [], { kind: 'account', neg: round % 2 === 1 })
      }
    }
    const enrollmentLookups = vi.spyOn(members, 'getEnrollment')
    const boundaryLookups = vi.spyOn(members, 'getBoundaries')

    const res = await query(await bearer(nerv), { limit: 50 })

    expect(res.data.labels).toHaveLength(6)
    const lookedUp = (spy: typeof enrollmentLookups | typeof boundaryLookups) =>
      spy.mock.calls
        .map(([did]) => did)
        .filter((did) => memberDids.includes(did))
        .sort()
    expect(lookedUp(enrollmentLookups)).toEqual([...memberDids].sort())
    expect(lookedUp(boundaryLookups)).toEqual([...memberDids].sort())
  })

  it('logs the caller, the returned count and the scanned count, and no subject', async () => {
    await append(recordUri('shared'), [TOKYO3])
    await append(recordUri('hidden'), [GEOFRONT])

    await query(await bearer(nerv), { subjects: [recordUri('shared')] })
    await query(await bearer(nerv))

    const entries = logger.debug.mock.calls
      .filter(([, message]) => message === 'moderation labels queried')
      .map(([entry]) => entry)
    expect(entries).toEqual([
      { callerDid: nerv.did(), returned: 1, scanned: 1 },
      { callerDid: nerv.did(), returned: 1, scanned: 2 },
    ])
  })

  describe('paging a scoped reader through the log', () => {
    const BOUNDARY_SETS = [[TOKYO3], [GEOFRONT], [TOKYO3, GEOFRONT], []]
    const MEMBER_BOUNDARIES = [[TOKYO3], [GEOFRONT], []]
    const MAX_PAGES = 200
    let runSerial = 0

    interface SeededLabel {
      seq: number
      subjectKey: string
      visible: boolean
    }

    interface LogSpec {
      subjects: Array<{ account: boolean; memberHolds: number }>
      entries: Array<{ subject: number; boundarySet: number }>
    }

    const logSpecArb: fc.Arbitrary<LogSpec> = fc.record({
      subjects: fc.array(
        fc.record({
          account: fc.boolean(),
          memberHolds: fc.nat(MEMBER_BOUNDARIES.length - 1),
        }),
        { minLength: 3, maxLength: 6 },
      ),
      entries: fc.array(
        fc.record({
          subject: fc.nat(5),
          boundarySet: fc.nat(BOUNDARY_SETS.length - 1),
        }),
        { minLength: 1, maxLength: 40 },
      ),
    })

    async function seedLog(spec: LogSpec): Promise<SeededLabel[]> {
      const run = ++runSerial
      const keys: string[] = []
      for (const [index, subject] of spec.subjects.entries()) {
        if (!subject.account) {
          keys.push(recordUri(`eva-${run}-${index}`))
          continue
        }
        const did = `did:plc:nerv-${run}-${index}`
        await enroll(did, MEMBER_BOUNDARIES[subject.memberHolds])
        keys.push(did)
      }
      const timesLabelled = new Map<string, number>()
      const seeded: SeededLabel[] = []
      for (const entry of spec.entries) {
        const index = entry.subject % spec.subjects.length
        const subject = spec.subjects[index]
        const subjectKey = keys[index]
        const times = timesLabelled.get(subjectKey) ?? 0
        timesLabelled.set(subjectKey, times + 1)
        const boundaries = subject.account
          ? []
          : BOUNDARY_SETS[entry.boundarySet]
        const label = await append(subjectKey, boundaries, {
          kind: subject.account ? 'account' : 'record',
          neg: times % 2 === 1,
        })
        const visibleBoundaries = subject.account
          ? MEMBER_BOUNDARIES[subject.memberHolds]
          : boundaries
        seeded.push({
          seq: label.seq,
          subjectKey,
          visible: visibleBoundaries.includes(TOKYO3),
        })
      }
      return seeded
    }

    async function pageToHead(
      headers: Record<string, string>,
      params: Record<string, unknown>,
      startCursor: number,
      head: number,
    ): Promise<Array<{ seqs: number[]; cursor: number }>> {
      const pages: Array<{ seqs: number[]; cursor: number }> = []
      let cursor = startCursor
      while (cursor < head) {
        expect(pages.length).toBeLessThan(MAX_PAGES)
        const res = await query(headers, {
          ...params,
          cursor: String(cursor),
        })
        expect(res.status).toBe(200)
        const next = Number(res.data.cursor)
        pages.push({ seqs: seqsOf(res), cursor: next })
        expect(next).toBeGreaterThanOrEqual(cursor)
        if (next === cursor) break
        cursor = next
      }
      return pages
    }

    function expectWellFormedPaging(
      pages: Array<{ seqs: number[]; cursor: number }>,
      limit: number,
      startCursor: number,
      expected: number[],
      invisible: Set<number>,
    ) {
      let previous = startCursor
      for (const page of pages) {
        expect(page.seqs.length).toBeLessThanOrEqual(limit)
        expect(page.cursor).toBeGreaterThanOrEqual(previous)
        previous = page.cursor
        for (const seq of page.seqs) expect(invisible.has(seq)).toBe(false)
      }
      expect(pages.flatMap((page) => page.seqs)).toEqual(expected)
    }

    it('(m1) every visible label comes back once, in order, never past limit, and the cursor never moves back', async () => {
      const headers = await bearer(nerv)
      await fc.assert(
        fc.asyncProperty(
          logSpecArb,
          fc.integer({ min: 1, max: 7 }),
          async (spec, limit) => {
            const startCursor = await labelStore.headSeq()
            const seeded = await seedLog(spec)
            const head = seeded[seeded.length - 1].seq

            const pages = await pageToHead(
              headers,
              { limit },
              startCursor,
              head,
            )

            expectWellFormedPaging(
              pages,
              limit,
              startCursor,
              seeded.filter((label) => label.visible).map((l) => l.seq),
              new Set(seeded.filter((l) => !l.visible).map((l) => l.seq)),
            )
          },
        ),
        { numRuns: 30 },
      )
    })

    it('(m2) a subjects query returns exactly the visible labels of those subjects across batches', async () => {
      const headers = await bearer(nerv)
      await fc.assert(
        fc.asyncProperty(
          logSpecArb,
          fc.integer({ min: 1, max: 4 }),
          fc.array(fc.nat(5), { minLength: 0, maxLength: 5 }),
          async (spec, limit, extraSubjects) => {
            // Five visible labels on the first subject guarantee more matches than any limit here.
            const firstAsVisibleRecord = {
              subjects: [{ account: false, memberHolds: 0 }, ...spec.subjects],
              entries: [
                ...Array.from({ length: 5 }, () => ({
                  subject: 0,
                  boundarySet: 0,
                })),
                ...spec.entries.map((entry) => ({
                  ...entry,
                  subject: (entry.subject % spec.subjects.length) + 1,
                })),
              ],
            }
            const startCursor = await labelStore.headSeq()
            const seeded = await seedLog(firstAsVisibleRecord)
            const head = seeded[seeded.length - 1].seq
            const keys = [...new Set(seeded.map((label) => label.subjectKey))]
            const chosen = new Set([
              keys[0],
              ...extraSubjects.map((index) => keys[index % keys.length]),
            ])
            const inChosen = seeded.filter((l) => chosen.has(l.subjectKey))

            const pages = await pageToHead(
              headers,
              { limit, subjects: [...chosen] },
              startCursor,
              head,
            )

            expectWellFormedPaging(
              pages,
              limit,
              startCursor,
              inChosen.filter((l) => l.visible).map((l) => l.seq),
              new Set(seeded.filter((l) => !l.visible).map((l) => l.seq)),
            )
          },
        ),
        { numRuns: 30 },
      )
    })
  })

  describe('(m3) a moderation service paging', () => {
    it('(m3a) returns 50 labels by default and the other 5 on the next page', async () => {
      const appended: number[] = []
      for (let index = 0; index < 55; index++) {
        appended.push(
          (await append(recordUri(`unit-${index}`), [GEOFRONT])).seq,
        )
      }
      const headers = await bearer(moderator)

      const first = await query(headers)
      const second = await query(headers, { cursor: first.data.cursor })

      expect(seqsOf(first)).toEqual(appended.slice(0, 50))
      expect(first.data.cursor).toBe(String(appended[49]))
      expect(seqsOf(second)).toEqual(appended.slice(50))
    })

    it('(m3b) pages two subjects with 7 labels between them 3 at a time, skipping the other subject', async () => {
      const shinji = recordUri('shinji')
      const rei = recordUri('rei')
      const noise = recordUri('kaworu')
      const wanted: number[] = []
      for (let index = 0; index < 7; index++) {
        const subject = index % 2 === 0 ? shinji : rei
        const label = await append(subject, [GEOFRONT], {
          neg: Math.floor(index / 2) % 2 === 1,
        })
        wanted.push(label.seq)
        await append(noise, [TOKYO3], { neg: index % 2 === 1 })
      }
      const head = await labelStore.headSeq()
      const headers = await bearer(moderator)

      const pages: AxiosResponse[] = []
      let cursor: string | undefined
      for (let call = 0; call < 3; call++) {
        const res = await query(headers, {
          limit: 3,
          subjects: [shinji, rei],
          cursor,
        })
        pages.push(res)
        cursor = res.data.cursor
      }

      expect(pages.map(seqsOf)).toEqual([
        wanted.slice(0, 3),
        wanted.slice(3, 6),
        wanted.slice(6),
      ])
      expect(pages.map((page) => page.data.cursor)).toEqual([
        String(wanted[2]),
        String(wanted[5]),
        String(head),
      ])
    })

    it('(m3c) a subjects poll returns a label appended after the previous poll', async () => {
      const unit = recordUri('unit-01')
      const first = await append(unit, [GEOFRONT])
      const headers = await bearer(moderator)

      const before = await query(headers, { limit: 3, subjects: [unit] })
      const added = await append(unit, [GEOFRONT], { neg: true })
      const after = await query(headers, {
        limit: 3,
        subjects: [unit],
        cursor: before.data.cursor,
      })

      expect(seqsOf(before)).toEqual([first.seq])
      expect(seqsOf(after)).toEqual([added.seq])
      expect(after.data.cursor).toBe(String(added.seq))
    })
  })

  it('(m4) a scoped page of record labels looks up no member boundaries for them', async () => {
    const keys = ['a', 'b', 'c'].map((name) => recordUri(`eva-${name}`))
    for (const key of keys) await append(key, [TOKYO3])
    const lookups = vi.spyOn(members, 'getBoundaries')
    const enrollmentLookups = vi.spyOn(members, 'getEnrollment')

    const res = await query(await bearer(nerv))

    expect(res.data.labels).toHaveLength(3)
    const memberLookups = lookups.mock.calls
      .map(([did]) => did)
      .filter((did) => did !== nerv.did())
    expect(memberLookups).toEqual([])
    const memberEnrollmentLookups = enrollmentLookups.mock.calls
      .map(([did]) => did)
      .filter((did) => did !== nerv.did())
    expect(memberEnrollmentLookups).toEqual([])
  })

  it('(m4b) a moderation log query reads no head sequence', async () => {
    await append(recordUri('eva-d'), [TOKYO3])
    const headReads = vi.spyOn(labelStore, 'headSeq')

    const res = await query(await bearer(moderator))

    expect(res.data.labels).toHaveLength(1)
    expect(headReads).not.toHaveBeenCalled()
  })

  it('(m5) a full scoped page stops at limit with the cursor on its last label, and the next page resumes after it', async () => {
    await append(recordUri('hidden-a'), [GEOFRONT])
    await append(recordUri('hidden-b'), [GEOFRONT])
    const visible: number[] = []
    for (let index = 0; index < 5; index++) {
      visible.push((await append(recordUri(`seen-${index}`), [TOKYO3])).seq)
    }
    const trailingMember = ASUKA_DID
    await enroll(trailingMember, [TOKYO3])
    await appendAccount(trailingMember)
    const lookups = vi.spyOn(members, 'getBoundaries')
    const headers = await bearer(nerv)

    const first = await query(headers, { limit: 3 })
    const second = await query(headers, {
      limit: 3,
      cursor: first.data.cursor,
    })

    expect(seqsOf(first)).toEqual(visible.slice(0, 3))
    expect(first.data.cursor).toBe(String(visible[2]))
    expect(seqsOf(second).slice(0, 2)).toEqual(visible.slice(3))
    // Reading past the page would look the trailing account up for nothing.
    expect(
      lookups.mock.calls.filter(([did]) => did === trailingMember),
    ).toHaveLength(1)
  })
})
