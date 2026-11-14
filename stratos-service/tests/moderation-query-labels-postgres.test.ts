/**
 * queryLabels against the Postgres stores. Mirrors the paging, scope, subject
 * and caller-type cases in moderation-query-labels.test.ts so both backends
 * hold the same contract.
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
  stratosLexicons,
  type BoundaryCatalogStore,
  type BoundaryDefinition,
  type LabelSubjectKind,
  type StoredLabel,
} from '@northskysocial/stratos-core'

import type { AppContext } from '../src/context-types.js'
import {
  closeServicePgDb,
  createServicePgDb,
  migrateServicePgDb,
  type ServicePgDb,
} from '../src/db/pg.js'
import { PgEnrollmentStoreWriter } from '../src/infra/storage/postgres/index.js'
import {
  PgLabelStore,
  QUERY_LABELS_METHOD,
  registerModerationHandlers,
} from '../src/features/moderation/index.js'
import { createPgBoundaryStore } from '../src/features/boundary/store.js'
import { migratePgBoundaries } from '../src/features/boundary/migrate.js'
import { ActiveBoundaryEnrollmentStore } from '../src/features/boundary/enrollment-store.js'
import { ReservedDomainEnrollmentStore } from '../src/infra/storage/reserved-domain-enrollment-store.js'
import { createAuthVerifiers } from '../src/infra/auth/verifiers.js'
import { PgAdminSessionStore, PgAdminUserStore } from '../src/oauth/index.js'
import type { EnrollmentRecord } from '../src/oauth/index.js'
import { createTestConfig } from './utils'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const SERVICE_DID = 'did:web:stratos.test'
const QUERY_PATH = `/xrpc/${QUERY_LABELS_METHOD}`
const POST_COLLECTION = 'zone.stratos.feed.post'
const REI_DID = 'did:plc:rei-ayanami'
const ASUKA_DID = 'did:plc:asuka'
const SHINJI_DID = 'did:plc:shinji-ikari'
const KAWORU_DID = 'did:plc:kaworu-nagisa'
const TOKYO3 = `${SERVICE_DID}/tokyo-3`
const GEOFRONT = `${SERVICE_DID}/geofront`
const RESERVED = `${SERVICE_DID}/general`

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

function recordUri(rkey: string): string {
  return `at://${REI_DID}/${POST_COLLECTION}/${rkey}`
}

describe('zone.stratos.moderation.queryLabels on Postgres', () => {
  let serviceDb: ServicePgDb
  let cleanupClient: postgres.Sql
  let labelStore: PgLabelStore
  let boundaryStore: BoundaryCatalogStore
  let enrollmentStore: ActiveBoundaryEnrollmentStore
  let moderator: Secp256k1Keypair
  let nerv: Secp256k1Keypair
  let member: Secp256k1Keypair
  let logger: Record<'debug' | 'info' | 'warn' | 'error', Mock<LogFn>>
  let ctx: AppContext
  let httpServer: http.Server
  let baseUrl: string

  beforeAll(async () => {
    const pgUrl = await startPostgresContainer()
    cleanupClient = postgres(pgUrl, { max: 1 })
    serviceDb = createServicePgDb(pgUrl)
    await migrateServicePgDb(serviceDb)
    await migratePgBoundaries(serviceDb)
    boundaryStore = createPgBoundaryStore(serviceDb)
    for (const boundary of [TOKYO3, GEOFRONT]) {
      await boundaryStore.create(definitionOf(boundary))
    }
    labelStore = new PgLabelStore(serviceDb)
    enrollmentStore = new ActiveBoundaryEnrollmentStore(
      new ReservedDomainEnrollmentStore(
        new PgEnrollmentStoreWriter(serviceDb),
        RESERVED,
      ),
      boundaryStore,
    )
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
    nerv = await Secp256k1Keypair.create({ exportable: true })
    member = await Secp256k1Keypair.create({ exportable: true })
    const signingKey = await Secp256k1Keypair.create()
    const documents = new Map(
      [moderator, nerv, member].map((keypair) => [
        keypair.did(),
        didDocumentFor(keypair),
      ]),
    )
    const idResolver = {
      did: { resolve: async (did: string) => documents.get(did) },
    } as unknown as IdResolver
    const cfg = createTestConfig('/tmp/stratos-query-labels-postgres')
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
      enrollmentStore,
      boundaryStore,
      labelStore,
      logger,
      authVerifier: verifiers,
    } as unknown as AppContext

    await enroll(nerv.did(), [TOKYO3], true)

    const server = new XrpcServer(stratosLexicons)
    registerModerationHandlers(server, ctx)
    const app = express()
    app.use(server.router)
    httpServer = app.listen(0)
    baseUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => httpServer.close(resolve))
  })

  async function enroll(did: string, boundaries: string[], service = false) {
    const enrollment: EnrollmentRecord = {
      did,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:zTest',
      boundaries,
      ...(service ? { isService: true } : {}),
    }
    await enrollmentStore.enroll(enrollment)
  }

  async function bearer(keypair: Secp256k1Keypair) {
    const token = await createServiceJwt({
      iss: keypair.did(),
      aud: SERVICE_DID,
      lxm: QUERY_LABELS_METHOD,
      keypair,
    })
    return { authorization: `Bearer ${token}` }
  }

  async function append(
    subjectKey: string,
    boundaries: string[],
    kind: LabelSubjectKind = 'record',
  ): Promise<StoredLabel> {
    const latest = await labelStore.latestForSubject(subjectKey)
    const result = await labelStore.appendIfLatest(latest?.seq ?? null, {
      subjectKey,
      subjectKind: kind,
      val: '!takedown',
      neg: false,
      boundaries,
      createdBy: moderator.did(),
      createdAt: new Date().toISOString(),
    })
    if (result.kind !== 'appended') throw new Error('seed append lost')
    return result.label
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

  it('(q2) a scoped service sees shared record labels and member account labels, not the rest', async () => {
    const shared = await append(recordUri('shared'), [TOKYO3, GEOFRONT])
    await append(recordUri('geofront-only'), [GEOFRONT])
    await append(recordUri('unscoped'), [])
    await enroll(ASUKA_DID, [TOKYO3])
    const heldByMember = await append(ASUKA_DID, [], 'account')
    await enroll(SHINJI_DID, [GEOFRONT])
    await append(SHINJI_DID, [], 'account')
    const headers = await bearer(nerv)

    const active = await query(headers)
    await enrollmentStore.updateEnrollment(ASUKA_DID, { active: false })
    const inactive = await query(headers)

    expect(seqsOf(active)).toEqual([shared.seq, heldByMember.seq])
    expect(seqsOf(inactive)).toEqual([shared.seq, heldByMember.seq])
  })

  describe('(q2b) the reserved all-members domain is active in the catalog', () => {
    beforeEach(async () => {
      await boundaryStore.create(definitionOf(RESERVED))
    })

    afterEach(async () => {
      await cleanupClient`DELETE FROM enrollment_boundary`
      await cleanupClient`DELETE FROM boundary_definition WHERE boundary = ${RESERVED}`
    })

    it('hides the account label of a DID with no enrollment from a log and from a subjects query', async () => {
      const visible = await append(recordUri('shared'), [TOKYO3])
      await append(KAWORU_DID, [], 'account')
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
      const label = await append(SHINJI_DID, [], 'account')
      const headers = await bearer(nerv)

      const active = await query(headers)
      await enrollmentStore.updateEnrollment(SHINJI_DID, { active: false })
      const inactive = await query(headers)
      await enrollmentStore.unenroll(SHINJI_DID)
      const unenrolled = await query(headers)

      expect(seqsOf(active)).toEqual([label.seq])
      expect(seqsOf(inactive)).toEqual([label.seq])
      expect(seqsOf(unenrolled)).toEqual([])
    })
  })

  it('(q4) an out-of-scope subject answers like a subject with no labels', async () => {
    await append(recordUri('geofront-secret'), [GEOFRONT])
    const inScope = await append(recordUri('tokyo-post'), [TOKYO3])
    const headers = await bearer(nerv)

    const outOfScope = await query(headers, {
      subjects: [recordUri('geofront-secret')],
    })
    const empty = await query(headers, {
      subjects: [recordUri('never-labelled')],
    })
    const visible = await query(headers, {
      subjects: [recordUri('tokyo-post')],
    })

    expect(outOfScope.data).toEqual(empty.data)
    expect(outOfScope.data.labels).toEqual([])
    expect(seqsOf(visible)).toEqual([inScope.seq])
  })

  it('(r5a) rejects an active member holding a boundary who presents a service JWT for its own DID', async () => {
    await enroll(member.did(), [TOKYO3])
    await append(recordUri('shared'), [TOKYO3])
    expect(await enrollmentStore.getBoundaries(member.did())).toEqual([TOKYO3])

    const res = await query(await bearer(member))

    expect(res.status).toBe(401)
    expect(res.data.labels).toBeUndefined()
  })

  it('(r5b) gives a service enrollment its scoped labels', async () => {
    const shared = await append(recordUri('shared'), [TOKYO3])
    await append(recordUri('geofront-only'), [GEOFRONT])

    const res = await query(await bearer(nerv))

    expect(res.status).toBe(200)
    expect(seqsOf(res)).toEqual([shared.seq])
  })

  it('(q6) a moderation service sees the full log and a plain service the scoped view', async () => {
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
})
