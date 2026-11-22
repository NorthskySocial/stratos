import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import axios, { type AxiosResponse } from 'axios'
import express from 'express'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import {
  createServiceJwt,
  XRPCError,
  Server as XrpcServer,
} from '@atproto/xrpc-server'
import { decode } from '@atcute/cbor'
import type { EnrollmentStore } from '../../src/oauth'
import type { AppContext } from '../../src'
import type { EnrollmentEventEmitter } from '../../src/context-types.js'
import { registerEnrollmentHandlers } from '../../src/features'
import { handleCallback } from '../../src/oauth/handlers/callback.js'
import { handleRevoke } from '../../src/oauth/handlers/revoke.js'
import { RepoWriteLocks } from '../../src/shared/repo-write-lock.js'
import {
  ACCOUNT_SUBJECT_TYPE,
  computeCid,
  stratosLexicons,
  type BoundaryCatalogStore,
  type BoundaryDefinition,
  type EnrollmentStoreReader,
  type LabelStore,
  type StoredLabel,
} from '@northskysocial/stratos-core'
import { createRecord } from '../../src/api/records/create.js'
import { registerModerationHandlers } from '../../src/features/moderation/index.js'
import {
  PdsEnrollmentSyncWorker,
  syncEnrollmentRecordToPds,
  verifyEnrolled,
  type PdsSyncQueueStore,
} from '../../src/features/enrollment/index.js'
import { ProfileRecordWriterImpl } from '../../src/features/enrollment/internal/profile-record-writer.js'
import { createAuthVerifiers } from '../../src/infra/auth/verifiers.js'
import { WriteRateLimiter } from '../../src/shared/rate-limiter.js'
import { EnrollmentServiceImpl } from '../../src/features/enrollment/adapter.js'
import { StratosActorStore } from '../../src/storage/sqlite/actor-store.js'
import { createMockBlobStore, createTestConfig } from '../utils'
import type { ServiceDb } from '../../src/db/index.js'
import {
  AuditedEnrollmentStore,
  BoundaryAudit,
  migrateBoundaryAudit,
  SqliteBoundaryAuditBackend,
  sqliteAuditSql,
} from '../../src/features/boundary-audit/index.js'
import { ActiveBoundaryEnrollmentStore } from '../../src/features/boundary/enrollment-store.js'
import { migrateSqliteBoundaries } from '../../src/features/boundary/migrate.js'
import { createSqliteBoundaryStore } from '../../src/features/boundary/store.js'
import { ReservedDomainEnrollmentStore } from '../../src/infra/storage/reserved-domain-enrollment-store.js'
import { SqliteEnrollmentStore } from '../../src/storage/sqlite/enrollment-store.js'

export const SERVICE_DID = 'did:web:bebop.example'
export const RESERVED_BOUNDARY = `${SERVICE_DID}/crew`
export const SWORDFISH_BOUNDARY = `${SERVICE_DID}/swordfish`
export const SET_ACTIVE_ROUTE = '/xrpc/zone.stratos.admin.setActive'
export const SPIKE_DID = 'did:plc:spikespiegel'
export const FAYE_DID = 'did:plc:fayevalentine'
export const JET_DID = 'did:plc:jetblack'
export const ED_DID = 'did:plc:radicaledward'
const MODERATOR_DID = 'did:plc:vicious'

export interface HoldsBackend {
  enrollmentStore: EnrollmentStore & EnrollmentStoreReader
  labelStore: LabelStore
  pdsSyncQueue: PdsSyncQueueStore
}

const ENROLLMENT_COLLECTION = 'zone.stratos.actor.enrollment'
const SERVICE_URL = 'http://localhost:3100'

function xrpcError(status: number, error: string): Response {
  return Response.json({ error, message: error }, { status })
}

/**
 * A member's PDS, reduced to the enrollment records Stratos puts and deletes.
 * Both the OAuth agent and the profile record writer reach it through the
 * fetch handler, so the real write paths run against it.
 */
export class FakePds {
  private readonly records = new Map<string, Record<string, unknown>>()

  enrollmentRecord(did: string): Record<string, unknown> | undefined {
    return this.records.get(`${did}/${SERVICE_DID}`)
  }

  readonly fetchHandler = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = new URL(url, SERVICE_URL).pathname.replace('/xrpc/', '')
    const input = (await new Response(init?.body).json()) as {
      repo: string
      collection: string
      rkey: string
      record?: Record<string, unknown>
    }
    if (input.collection !== ENROLLMENT_COLLECTION) {
      return xrpcError(400, 'InvalidRequest')
    }
    const uri = `at://${input.repo}/${input.collection}/${input.rkey}`
    switch (method) {
      case 'com.atproto.repo.putRecord': {
        this.records.set(`${input.repo}/${input.rkey}`, input.record ?? {})
        const cid = (await computeCid({ uri })).toString()
        return Response.json({ uri, cid })
      }
      case 'com.atproto.repo.deleteRecord':
        this.records.delete(`${input.repo}/${input.rkey}`)
        return Response.json({})
      default:
        return xrpcError(501, 'MethodNotImplemented')
    }
  }

  session(did: string) {
    return { did, fetchHandler: this.fetchHandler }
  }
}

/** Marks the member's enrollment record as published, on the row and the PDS. */
export async function publishEnrollmentRecord(
  backend: HoldsBackend,
  pds: FakePds,
  did: string,
): Promise<void> {
  await backend.enrollmentStore.updateEnrollment(did, {
    enrollmentRkey: SERVICE_DID,
  })
  const res = await pds.fetchHandler('/xrpc/com.atproto.repo.putRecord', {
    method: 'POST',
    body: JSON.stringify({
      repo: did,
      collection: ENROLLMENT_COLLECTION,
      rkey: SERVICE_DID,
      record: { service: SERVICE_URL },
    }),
  })
  expect(res.ok).toBe(true)
}

/** The real sync worker over the backend's queue, writing through `oauthClient`. */
function buildPdsSyncWorker(
  backend: HoldsBackend,
  oauthClient: { restore: Mock },
): PdsEnrollmentSyncWorker {
  return new PdsEnrollmentSyncWorker(
    {
      queue: backend.pdsSyncQueue,
      sync: (did, signal) =>
        syncEnrollmentRecordToPds(
          {
            enrollmentStore: backend.enrollmentStore,
            createAttestation: async () => ({
              sig: new Uint8Array([1, 9, 9, 8]),
              signingKey: 'did:key:zDnaeBebop',
            }),
            oauthClient: oauthClient as never,
            serviceDid: SERVICE_DID,
            publicUrl: SERVICE_URL,
          },
          did,
          signal,
        ),
    },
    {
      tickMs: 60_000,
      backoffBaseMs: 60_000,
      backoffCapMs: 60_000,
      maxAttempts: 3,
      claimLimit: 10,
      attemptTimeoutMs: 10_000,
    },
  )
}

interface MockResponse {
  statusCode: number
  body: unknown
}

function invokePostRoute(
  app: express.Application,
  path: string,
  body: unknown,
): Promise<MockResponse> {
  return new Promise((resolve, reject) => {
    let statusCode = 200
    const req = {
      query: {},
      body,
      headers: {},
      method: 'POST',
      url: path,
      _body: true,
    } as unknown as express.Request
    const res = {
      status(code: number) {
        statusCode = code
        return res
      },
      json(responseBody: unknown) {
        resolve({ statusCode, body: responseBody })
        return res
      },
      setHeader() {
        return res
      },
    } as unknown as express.Response

    app(req, res, (err?: unknown) => {
      if (err) {
        return reject(
          err instanceof Error
            ? err
            : new Error(`express next() called with: ${inspect(err)}`),
        )
      }
      resolve({ statusCode, body: null })
    })
  })
}

export interface SetActiveHarness {
  ctx: AppContext
  signals: string[]
  setActive: (did: string, active: boolean) => Promise<MockResponse>
}

/** The real setActive route over real stores; only admin auth is stubbed. */
export function buildSetActiveHarness(
  backend: HoldsBackend,
  repoWriteLocks: RepoWriteLocks = new RepoWriteLocks(),
): SetActiveHarness {
  const app = express()
  const enrollmentEvents: EnrollmentEventEmitter = new EventEmitter()
  const signals: string[] = []
  enrollmentEvents.on('activeChanged', ({ did }) => signals.push(did))
  const ctx = {
    app,
    enrollmentStore: backend.enrollmentStore,
    labelStore: backend.labelStore,
    enrollmentEvents,
    repoWriteLocks,
    enrollmentService: {
      isEnrolled: (did: string) => backend.enrollmentStore.isEnrolled(did),
      getEnrollment: vi.fn(),
    },
    boundaryResolver: {
      getBoundaries: (did: string) =>
        backend.enrollmentStore.getBoundaries(did),
    },
    authVerifier: {
      admin: vi.fn(async () => ({
        credentials: { type: 'admin', did: 'did:plc:haruki' },
      })),
      optionalStandard: vi.fn(async () => ({ credentials: { did: null } })),
    },
    serviceDid: SERVICE_DID,
    cfg: {
      service: { publicUrl: 'https://stratos.example.com' },
      stratos: { serviceDid: SERVICE_DID, allowedDomains: [] },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as AppContext
  registerEnrollmentHandlers({ method: vi.fn() } as never, ctx)
  return {
    ctx,
    signals,
    setActive: (did, active) =>
      invokePostRoute(app, SET_ACTIVE_ROUTE, { did, active }),
  }
}

export interface Seeded {
  did: string
  active?: boolean
  operatorHold?: boolean
}

export async function seedMember(
  backend: HoldsBackend,
  { did, active = true, operatorHold = false }: Seeded,
): Promise<void> {
  await backend.enrollmentStore.enroll({
    did,
    enrolledAt: '2025-01-01T00:00:00Z',
    pdsEndpoint: 'https://pds.bebop.example',
    signingKeyDid: 'did:key:zDnaeBebop',
    active,
    operatorHold,
    boundaries: [RESERVED_BOUNDARY, SWORDFISH_BOUNDARY],
  })
}

async function appendAccountTakedown(
  labelStore: LabelStore,
  did: string,
  neg: boolean,
): Promise<void> {
  const latest = await labelStore.latestForSubject(did)
  const result = await labelStore.appendIfLatest(latest?.seq ?? null, {
    subjectKey: did,
    subjectKind: 'account',
    val: '!takedown',
    neg,
    boundaries: [],
    createdBy: MODERATOR_DID,
    createdAt: new Date().toISOString(),
  })
  expect(result.kind).toBe('appended')
}

export function takeDownAccount(labelStore: LabelStore, did: string) {
  return appendAccountTakedown(labelStore, did, false)
}

export function liftAccountTakedown(labelStore: LabelStore, did: string) {
  return appendAccountTakedown(labelStore, did, true)
}

export async function rowOf(backend: HoldsBackend, did: string) {
  const row = await backend.enrollmentStore.getEnrollment(did)
  return row
    ? {
        active: row.active,
        operatorHold: row.operatorHold,
        signingKeyDid: row.signingKeyDid,
        enrolledAt: row.enrolledAt,
        boundaries: [
          ...(await backend.enrollmentStore.getBoundaries(did)),
        ].sort(),
      }
    : null
}

/** setActive scenarios shared by both backends. */
export function defineSetActiveScenarios(getBackend: () => HoldsBackend) {
  it('deactivates an active member and records the operator hold', async () => {
    const backend = getBackend()
    const { setActive, signals } = buildSetActiveHarness(backend)
    await seedMember(backend, { did: SPIKE_DID })

    const res = await setActive(SPIKE_DID, false)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ did: SPIKE_DID, active: false })
    const row = await rowOf(backend, SPIKE_DID)
    expect(row?.operatorHold).toBe(true)
    expect(row?.active).toBe(false)
    expect(signals).toEqual([SPIKE_DID])
  })

  it('reactivates a held member when no takedown is in force', async () => {
    const backend = getBackend()
    const { setActive, signals } = buildSetActiveHarness(backend)
    await seedMember(backend, { did: SPIKE_DID })
    await setActive(SPIKE_DID, false)
    signals.length = 0

    const res = await setActive(SPIKE_DID, true)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ did: SPIKE_DID, active: true })
    const row = await rowOf(backend, SPIKE_DID)
    expect(row?.operatorHold).toBe(false)
    expect(row?.active).toBe(true)
    expect(signals).toEqual([SPIKE_DID])
  })

  it('refuses to activate a member while an account takedown is in force', async () => {
    const backend = getBackend()
    const { setActive, signals } = buildSetActiveHarness(backend)
    await seedMember(backend, { did: FAYE_DID, active: false })
    await takeDownAccount(backend.labelStore, FAYE_DID)
    const before = await rowOf(backend, FAYE_DID)

    const res = await setActive(FAYE_DID, true)

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({
      error: 'AccountTakenDown',
      message: 'An account takedown is in force for this member',
    })
    expect(await rowOf(backend, FAYE_DID)).toEqual(before)
    expect(signals).toEqual([])
  })

  it('records the operator hold when deactivating during a takedown', async () => {
    const backend = getBackend()
    const { setActive, signals } = buildSetActiveHarness(backend)
    await seedMember(backend, { did: FAYE_DID, active: false })
    await takeDownAccount(backend.labelStore, FAYE_DID)

    const res = await setActive(FAYE_DID, false)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ did: FAYE_DID, active: false })
    const row = await rowOf(backend, FAYE_DID)
    expect(row?.operatorHold).toBe(true)
    expect(row?.active).toBe(false)
    expect(signals).toEqual([])
  })

  it('reactivates once the takedown is lifted and the hold is cleared', async () => {
    const backend = getBackend()
    const { setActive, signals } = buildSetActiveHarness(backend)
    await seedMember(backend, { did: FAYE_DID, active: false })
    await takeDownAccount(backend.labelStore, FAYE_DID)
    await setActive(FAYE_DID, false)
    await liftAccountTakedown(backend.labelStore, FAYE_DID)
    signals.length = 0

    const res = await setActive(FAYE_DID, true)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ did: FAYE_DID, active: true })
    const row = await rowOf(backend, FAYE_DID)
    expect(row?.operatorHold).toBe(false)
    expect(row?.active).toBe(true)
    expect(signals).toEqual([FAYE_DID])
  })

  it('applies a takedownHold override without storing it', async () => {
    const backend = getBackend()
    const { ctx, signals } = buildSetActiveHarness(backend)
    const { applyEnrollmentHolds } =
      await import('../../src/features/enrollment/holds.js')
    await seedMember(backend, { did: JET_DID })

    const held = await applyEnrollmentHolds(ctx, JET_DID, {
      takedownHold: true,
    })

    expect(held).toEqual({ active: false, operatorHold: false })
    const heldRow = await rowOf(backend, JET_DID)
    expect(heldRow?.active).toBe(false)
    expect(heldRow?.operatorHold).toBe(false)
    expect(signals).toEqual([JET_DID])

    const lifted = await applyEnrollmentHolds(ctx, JET_DID, {})

    expect(lifted).toEqual({ active: true, operatorHold: false })
    expect((await rowOf(backend, JET_DID))?.active).toBe(true)
    expect(signals).toEqual([JET_DID, JET_DID])
  })
}

export interface CallbackHarness {
  pds: FakePds
  oauthClient: {
    callback: ReturnType<typeof vi.fn>
    revoke: ReturnType<typeof vi.fn>
    restore: Mock
  }
  profileRecordWriter: {
    putEnrollmentRecord: ReturnType<typeof vi.fn>
    deleteEnrollmentRecord: ReturnType<typeof vi.fn>
  }
  initRepo: ReturnType<typeof vi.fn>
  createSigningKey: ReturnType<typeof vi.fn>
  complete: (did: string) => Promise<MockHttpResponse>
  revokeAs: (did: string) => Promise<MockHttpResponse>
}

export interface MockHttpResponse {
  status: ReturnType<typeof vi.fn>
  json: ReturnType<typeof vi.fn>
  redirect: ReturnType<typeof vi.fn>
}

function mockHttpResponse(): MockHttpResponse {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    redirect: vi.fn(),
  }
}

/**
 * The real callback and revoke handlers and PDS sync worker over real stores.
 * The OAuth client, the member's PDS, the callback's PDS record writer and key
 * provisioning are external collaborators.
 */
export function buildCallbackHarness(
  backend: HoldsBackend,
  repoWriteLocks: RepoWriteLocks = new RepoWriteLocks(),
): CallbackHarness {
  const pds = new FakePds()
  const oauthClient = {
    callback: vi.fn(),
    revoke: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn(async (did: string) => pds.session(did)),
  }
  const profileRecordWriter = {
    putEnrollmentRecord: vi.fn().mockResolvedValue(undefined),
    deleteEnrollmentRecord: vi.fn().mockResolvedValue(undefined),
  }
  const initRepo = vi.fn().mockResolvedValue(undefined)
  const createSigningKey = vi.fn().mockResolvedValue('did:key:zDnaeNewKey')
  const config = {
    oauthClient,
    enrollmentStore: backend.enrollmentStore,
    enrollmentConfig: { mode: 'open' },
    enrollmentValidator: {
      validate: vi.fn().mockResolvedValue({
        allowed: true,
        pdsEndpoint: 'https://pds.bebop.example',
      }),
    },
    idResolver: {},
    profileRecordWriter,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    enrollmentEvents: new EventEmitter(),
    baseUrl: 'http://localhost:3100',
    allowedRedirectOrigins: [],
    serviceEndpoint: 'http://localhost:3100',
    serviceDid: SERVICE_DID,
    defaultBoundaries: [RESERVED_BOUNDARY],
    initRepo,
    createSigningKey,
    createAttestation: vi.fn().mockResolvedValue({
      sig: new Uint8Array(),
      signingKey: 'did:key:zDnaeNewKey',
    }),
    repoWriteLocks,
    pdsSyncWorker: buildPdsSyncWorker(backend, oauthClient),
  }

  return {
    pds,
    oauthClient,
    profileRecordWriter,
    initRepo,
    createSigningKey,
    complete: async (did) => {
      oauthClient.callback.mockResolvedValue({
        session: {
          sub: did,
          getTokenInfo: vi.fn().mockResolvedValue({ scope: 'atproto' }),
        },
      })
      const res = mockHttpResponse()
      const handler = handleCallback(config as never) as unknown as (
        req: { url: string },
        res: MockHttpResponse,
      ) => Promise<unknown>
      await handler(
        { url: 'http://localhost:3100/oauth/callback?code=foo&state=bar' },
        res,
      )
      return res
    },
    revokeAs: async (did) => {
      const res = mockHttpResponse()
      const handler = handleRevoke(
        config as never,
        async () => did,
      ) as unknown as (req: object, res: MockHttpResponse) => Promise<unknown>
      await handler({}, res)
      return res
    },
  }
}

export const ENROLLMENT_DENIED_BODY = {
  error: 'EnrollmentDenied',
  message: 'Your enrollment on this Stratos service is not active',
}

export function expectNothingProvisioned(harness: CallbackHarness) {
  expect(harness.profileRecordWriter.putEnrollmentRecord).not.toHaveBeenCalled()
  expect(harness.initRepo).not.toHaveBeenCalled()
  expect(harness.createSigningKey).not.toHaveBeenCalled()
  expect(harness.oauthClient.revoke).not.toHaveBeenCalled()
}

/** Callback scenarios shared by both backends. */
export function defineCallbackHoldScenarios(getBackend: () => HoldsBackend) {
  it('denies the callback for a takedown-held member and writes nothing', async () => {
    const backend = getBackend()
    const harness = buildCallbackHarness(backend)
    await seedMember(backend, { did: FAYE_DID, active: false })
    await takeDownAccount(backend.labelStore, FAYE_DID)
    const before = await rowOf(backend, FAYE_DID)

    const res = await harness.complete(FAYE_DID)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(ENROLLMENT_DENIED_BODY)
    expect(await rowOf(backend, FAYE_DID)).toEqual(before)
    expectNothingProvisioned(harness)
  })
}

export const GEOFRONT_BOUNDARY = `${SERVICE_DID}/geofront`
const CREATE_LABEL_METHOD = 'zone.stratos.moderation.createLabel'
const QUERY_LABELS_METHOD = 'zone.stratos.moderation.queryLabels'
const POST_COLLECTION = 'zone.stratos.feed.post'

export function catalogDefinition(boundary: string): BoundaryDefinition {
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

/**
 * The reserved all-members boundary stays out of the catalog, so the catalog
 * filter drops it and a boundary share means a real one.
 */
export async function seedBoundaryCatalog(
  catalog: BoundaryCatalogStore,
): Promise<void> {
  for (const boundary of [SWORDFISH_BOUNDARY, GEOFRONT_BOUNDARY]) {
    await catalog.create(catalogDefinition(boundary))
  }
}

export interface MembershipStores {
  members: ActiveBoundaryEnrollmentStore
  catalog: BoundaryCatalogStore
}

/**
 * The SQLite enrollment decorator chain createStorageContext builds, over a
 * real boundary catalog that holds `boundaries`. The reserved all-members
 * boundary stays out of the catalog unless it is listed.
 */
export async function buildSqliteMembershipStores(
  db: ServiceDb,
  options: {
    serviceDid: string
    reservedBoundary: string
    boundaries: string[]
  },
): Promise<MembershipStores> {
  await migrateSqliteBoundaries(db)
  const catalog = createSqliteBoundaryStore(db)
  for (const boundary of options.boundaries) {
    if (!(await catalog.create(catalogDefinition(boundary)))) {
      throw new Error(`catalog fixture rejected ${boundary}`)
    }
  }
  await migrateBoundaryAudit(sqliteAuditSql(db))
  const audit = new BoundaryAudit(
    options.serviceDid,
    new SqliteBoundaryAuditBackend(db),
  )
  const auditKey = await Secp256k1Keypair.create()
  audit.setSigner({
    publicKey: auditKey.did(),
    sign: (bytes) => auditKey.sign(bytes),
  })
  const members = new ActiveBoundaryEnrollmentStore(
    new ReservedDomainEnrollmentStore(
      new AuditedEnrollmentStore(new SqliteEnrollmentStore(db), audit),
      options.reservedBoundary,
    ),
    catalog,
  )
  return { members, catalog }
}

export interface SeededAccount {
  did: string
  active?: boolean
  operatorHold?: boolean
  custody?: 'stratos' | 'pds'
  isService?: boolean
  boundaries?: string[]
}

export async function seedAccount(
  backend: HoldsBackend,
  {
    did,
    active = true,
    operatorHold = false,
    custody = 'stratos',
    isService = false,
    boundaries = [SWORDFISH_BOUNDARY],
  }: SeededAccount,
): Promise<void> {
  await backend.enrollmentStore.enroll({
    did,
    enrolledAt: '2025-01-01T00:00:00Z',
    pdsEndpoint: 'https://pds.bebop.example',
    signingKeyDid: 'did:key:zDnaeBebop',
    active,
    operatorHold,
    custody,
    ...(isService ? { isService } : {}),
    boundaries,
  })
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

export interface AccountLabelHarness {
  ctx: AppContext
  signals: string[]
  moderatorDid: string
  /** The DID of the key that signs service-auth as an enrolled service. */
  serviceDid: string
  /** Sends a raw createLabel body as the moderation service. */
  createLabel: (body: Record<string, unknown>) => Promise<AxiosResponse>
  takedown: (did: string, extra?: { ref?: string }) => Promise<AxiosResponse>
  negate: (did: string, extra?: { ref?: string }) => Promise<AxiosResponse>
  queryAsModerator: () => Promise<AxiosResponse>
  queryAsService: () => Promise<AxiosResponse>
  labels: () => Promise<StoredLabel[]>
  close: () => Promise<void>
}

/**
 * The real createLabel and queryLabels routes with their real auth verifiers
 * over real stores. Only the signing keys and the DID resolver are local.
 */
export async function buildAccountLabelHarness(
  backend: HoldsBackend,
): Promise<AccountLabelHarness> {
  const moderator = await Secp256k1Keypair.create({ exportable: true })
  const service = await Secp256k1Keypair.create({ exportable: true })
  const documents = new Map(
    [moderator, service].map((keypair) => [
      keypair.did(),
      didDocumentFor(keypair),
    ]),
  )
  const idResolver = {
    did: { resolve: async (did: string) => documents.get(did) },
  } as unknown as IdResolver
  const cfg = createTestConfig(tmpdir())
  cfg.moderationServiceDids = [moderator.did()]
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
  const enrollmentEvents: EnrollmentEventEmitter = new EventEmitter()
  const signals: string[] = []
  enrollmentEvents.on('activeChanged', ({ did }) => signals.push(did))
  const authVerifier = createAuthVerifiers(
    cfg.service.did,
    idResolver,
    cfg,
    backend.enrollmentStore,
    {} as never,
    {} as never,
    [],
    {} as never,
    undefined,
    true,
    await Secp256k1Keypair.create(),
    undefined,
    logger,
  )
  const ctx = {
    cfg,
    serviceDid: cfg.service.did,
    enrollmentStore: backend.enrollmentStore,
    labelStore: backend.labelStore,
    enrollmentEvents,
    repoWriteLocks: new RepoWriteLocks(),
    writeRateLimiter: new WriteRateLimiter(),
    logger,
    authVerifier,
  } as unknown as AppContext

  const server = new XrpcServer(stratosLexicons)
  registerModerationHandlers(server, ctx)
  const app = express()
  app.use(server.router)
  const httpServer: http.Server = app.listen(0)
  const baseUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`

  const bearer = async (keypair: Secp256k1Keypair, lxm: string) => ({
    authorization: `Bearer ${await createServiceJwt({
      iss: keypair.did(),
      aud: cfg.service.did,
      lxm,
      keypair,
    })}`,
  })
  const createLabel = async (body: Record<string, unknown>) =>
    axios.post(`${baseUrl}/xrpc/${CREATE_LABEL_METHOD}`, body, {
      headers: await bearer(moderator, CREATE_LABEL_METHOD),
      validateStatus: () => true,
    })
  const accountLabel = (did: string, neg: boolean, ref?: string) =>
    createLabel({
      subject: { $type: ACCOUNT_SUBJECT_TYPE, did },
      val: '!takedown',
      ...(neg ? { neg } : {}),
      ...(ref ? { ref } : {}),
    })
  const query = async (keypair: Secp256k1Keypair) =>
    axios.get(`${baseUrl}/xrpc/${QUERY_LABELS_METHOD}`, {
      headers: await bearer(keypair, QUERY_LABELS_METHOD),
      validateStatus: () => true,
    })

  return {
    ctx,
    signals,
    moderatorDid: moderator.did(),
    serviceDid: service.did(),
    createLabel,
    takedown: (did, extra) => accountLabel(did, false, extra?.ref),
    negate: (did, extra) => accountLabel(did, true, extra?.ref),
    queryAsModerator: () => query(moderator),
    queryAsService: () => query(service),
    labels: () => backend.labelStore.listFrom({ limit: 100 }),
    close: async () => {
      ctx.repoWriteLocks.destroy()
      await new Promise((resolve) => httpServer.close(resolve))
    },
  }
}

export async function expectMemberRefusedWrites(
  harness: AccountLabelHarness,
  did: string,
): Promise<void> {
  await expect(
    createRecord(
      harness.ctx,
      {
        repo: did,
        collection: POST_COLLECTION,
        record: { $type: POST_COLLECTION, text: 'Bang.' },
      },
      did,
    ),
  ).rejects.toMatchObject({ customErrorName: 'NotEnrolled' })
  await expect(
    verifyEnrolled(did, {
      idResolver: {} as IdResolver,
      enrollmentStore: harness.ctx.enrollmentStore,
      config: harness.ctx.cfg.enrollment,
    }),
  ).rejects.toMatchObject({ name: 'EnrollmentDeniedError' })
}

/** Account-subject createLabel scenarios shared by both backends. */
export function defineAccountLabelScenarios(getBackend: () => HoldsBackend) {
  const open: AccountLabelHarness[] = []
  const openHarness = async () => {
    const harness = await buildAccountLabelHarness(getBackend())
    open.push(harness)
    return harness
  }
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(open.splice(0).map((harness) => harness.close()))
  })

  it('takes down an active member, deactivates it and writes no record marker', async () => {
    const backend = getBackend()
    const harness = await openHarness()
    await seedAccount(backend, { did: SPIKE_DID })

    const res = await harness.takedown(SPIKE_DID, { ref: 'case-0100' })

    expect(res.status).toBe(200)
    expect(res.data.label).toMatchObject({
      subject: { $type: ACCOUNT_SUBJECT_TYPE, did: SPIKE_DID },
      val: '!takedown',
      neg: false,
      ref: 'case-0100',
    })
    const labels = await harness.labels()
    expect(labels).toHaveLength(1)
    expect(labels[0]).toMatchObject({
      subjectKind: 'account',
      subjectKey: SPIKE_DID,
      boundaries: [],
      createdBy: harness.moderatorDid,
    })
    expect(labels[0].cid ?? null).toBeNull()
    const row = await rowOf(backend, SPIKE_DID)
    expect(row?.active).toBe(false)
    expect(row?.operatorHold).toBe(false)
    expect(harness.signals).toEqual([SPIKE_DID])
    await expectMemberRefusedWrites(harness, SPIKE_DID)
  })

  it('reactivates the member when the takedown is negated', async () => {
    const backend = getBackend()
    const harness = await openHarness()
    await seedAccount(backend, { did: SPIKE_DID })
    await harness.takedown(SPIKE_DID)

    const res = await harness.negate(SPIKE_DID)

    expect(res.status).toBe(200)
    expect(res.data.label).toMatchObject({ neg: true })
    const labels = await harness.labels()
    expect(labels.map((label) => label.neg)).toEqual([false, true])
    const row = await rowOf(backend, SPIKE_DID)
    expect(row?.active).toBe(true)
    expect(row?.operatorHold).toBe(false)
    expect(harness.signals).toEqual([SPIKE_DID, SPIKE_DID])
  })

  it('keeps an operator-held member inactive when the takedown is negated', async () => {
    const backend = getBackend()
    const harness = await openHarness()
    const { setActive } = buildSetActiveHarness(backend)
    await seedAccount(backend, { did: FAYE_DID })
    await harness.takedown(FAYE_DID)
    expect((await setActive(FAYE_DID, false)).statusCode).toBe(200)

    const res = await harness.negate(FAYE_DID)

    expect(res.status).toBe(200)
    expect(await harness.labels()).toHaveLength(2)
    const held = await rowOf(backend, FAYE_DID)
    expect(held?.active).toBe(false)
    expect(held?.operatorHold).toBe(true)

    expect((await setActive(FAYE_DID, true)).statusCode).toBe(200)
    const released = await rowOf(backend, FAYE_DID)
    expect(released?.active).toBe(true)
    expect(released?.operatorHold).toBe(false)
  })

  it('refuses an account with no enrollment and writes nothing', async () => {
    const backend = getBackend()
    const harness = await openHarness()

    const res = await harness.takedown(ED_DID)

    expect(res.status).toBe(400)
    expect(res.data.error).toBe('SubjectNotFound')
    expect(await harness.labels()).toEqual([])
    expect(await backend.enrollmentStore.getEnrollment(ED_DID)).toBeNull()
    expect(harness.signals).toEqual([])
  })

  it('treats a pds-custody member like a stratos-custody member', async () => {
    const backend = getBackend()
    const harness = await openHarness()
    await seedAccount(backend, { did: JET_DID, custody: 'pds' })

    const takedown = await harness.takedown(JET_DID)

    expect(takedown.status).toBe(200)
    expect((await rowOf(backend, JET_DID))?.active).toBe(false)

    const negation = await harness.negate(JET_DID)

    expect(negation.status).toBe(200)
    expect((await rowOf(backend, JET_DID))?.active).toBe(true)
    expect(await harness.labels()).toHaveLength(2)
  })

  it('leaves the member inactive and unlabelled when the append fails, and a retry finishes', async () => {
    const backend = getBackend()
    const harness = await openHarness()
    await seedAccount(backend, { did: SPIKE_DID })
    vi.spyOn(backend.labelStore, 'appendIfLatest').mockRejectedValueOnce(
      new Error('label log unavailable'),
    )

    const failed = await harness.takedown(SPIKE_DID)

    expect(failed.status).toBe(500)
    const row = await rowOf(backend, SPIKE_DID)
    expect(row?.active).toBe(false)
    expect(row?.operatorHold).toBe(false)
    expect(await harness.labels()).toEqual([])

    const retry = await harness.takedown(SPIKE_DID)

    expect(retry.status).toBe(200)
    expect(await harness.labels()).toHaveLength(1)
    expect((await rowOf(backend, SPIKE_DID))?.active).toBe(false)
  })

  it('rejects a service enrollment as an account subject and writes nothing', async () => {
    const backend = getBackend()
    const harness = await openHarness()
    await seedAccount(backend, { did: ED_DID, isService: true })
    const before = await rowOf(backend, ED_DID)

    const res = await harness.takedown(ED_DID)

    expect(res.status).toBe(400)
    expect(res.data.error).toBe('InvalidRequest')
    expect(res.data.message).toContain('not a service')
    expect(await harness.labels()).toEqual([])
    expect(await rowOf(backend, ED_DID)).toEqual(before)
    expect(harness.signals).toEqual([])
  })
}

const UNENROLL_METHOD = 'zone.stratos.enrollment.unenroll'

export interface Pause {
  /** Settles once the paused call has started. */
  reached: Promise<void>
  resume: () => void
}

type CallThrough = (...args: unknown[]) => unknown

interface PausableMock {
  getMockImplementation(): unknown
  mockImplementationOnce(implementation: CallThrough): unknown
}

/** Holds the next call of an external collaborator's mock until resumed. */
export function pauseNextCall(mock: PausableMock): Pause {
  let reach!: () => void
  let resume!: () => void
  const reached = new Promise<void>((resolve) => {
    reach = resolve
  })
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  const settled = mock.getMockImplementation() as CallThrough | undefined
  mock.mockImplementationOnce(async (...args: unknown[]) => {
    reach()
    await gate
    return settled?.(...args)
  })
  return { reached, resume }
}

/** Holds the next call of a real store method, then forwards it to the store. */
export function pauseNextStoreCall<T extends object, K extends keyof T>(
  store: T,
  method: K,
): Pause {
  const forward = (store[method] as (...args: unknown[]) => unknown).bind(store)
  const spy = vi.spyOn(store, method as never) as unknown as Mock
  const pause = pauseNextCall(spy.mockImplementation(forward))
  return pause
}

/** Long enough for an unlocked unenroll to finish its local delete. */
export function settleBriefly(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50))
}

export interface UnenrollResult {
  status: number
  body: unknown
}

export interface UnenrollHarness {
  pds: FakePds
  pdsSyncWorker: { cancel: Mock }
  oauthClient: { revoke: Mock }
  logger: { warn: Mock }
  unenrollAs: (did: string) => Promise<UnenrollResult>
  close: () => void
}

/**
 * The real XRPC unenroll handler, enrollment service, PDS sync worker and PDS
 * record writer over real stores. The member's PDS and the OAuth client are
 * external collaborators. The enrollment check the standard verifier makes
 * runs first.
 */
export function buildUnenrollHarness(
  backend: HoldsBackend,
  repoWriteLocks: RepoWriteLocks = new RepoWriteLocks(),
): UnenrollHarness {
  const actorDir = mkdtempSync(join(tmpdir(), 'stratos-unenroll-actors-'))
  const actorStore = new StratosActorStore({
    dataDir: actorDir,
    blobstore: () => createMockBlobStore(),
    cborToRecord: (content) => decode(content) as Record<string, unknown>,
  })
  const enrollmentEvents: EnrollmentEventEmitter = new EventEmitter()
  const methods = new Map<
    string,
    { handler: (ctx: unknown) => Promise<{ body: unknown }> }
  >()
  const pds = new FakePds()
  const oauthClient = {
    revoke: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn(async (did: string) => pds.session(did)),
  }
  const pdsSyncWorker = buildPdsSyncWorker(backend, oauthClient)
  const forwardCancel = pdsSyncWorker.cancel.bind(pdsSyncWorker)
  const cancel = vi
    .spyOn(pdsSyncWorker, 'cancel')
    .mockImplementation(forwardCancel) as unknown as Mock
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
  const cfg = createTestConfig(actorDir)
  const ctx = {
    app: express(),
    cfg,
    enrollmentStore: backend.enrollmentStore,
    labelStore: backend.labelStore,
    enrollmentEvents,
    repoWriteLocks,
    actorStore,
    enrollmentService: new EnrollmentServiceImpl(
      backend.enrollmentStore,
      (did) => actorStore.create(did),
      (did) => actorStore.destroy(did),
      undefined,
      enrollmentEvents,
    ),
    pdsSyncWorker,
    profileRecordWriter: new ProfileRecordWriterImpl(async () => ({
      handler: pds.fetchHandler,
    })),
    oauthClient,
    boundaryResolver: {
      getBoundaries: (did: string) =>
        backend.enrollmentStore.getBoundaries(did),
    },
    authVerifier: { standard: vi.fn(), admin: vi.fn() },
    serviceDid: SERVICE_DID,
    logger,
  } as unknown as AppContext
  registerEnrollmentHandlers(
    {
      method: (nsid: string, config: never) => methods.set(nsid, config),
    } as never,
    ctx,
  )

  return {
    pds,
    pdsSyncWorker: { cancel },
    oauthClient,
    logger,
    unenrollAs: async (did) => {
      await verifyEnrolled(did, {
        idResolver: {} as IdResolver,
        enrollmentStore: backend.enrollmentStore,
        config: cfg.enrollment,
      })
      try {
        const res = await methods.get(UNENROLL_METHOD)!.handler({
          params: {},
          auth: { credentials: { type: 'user', did } },
        })
        return { status: 200, body: res.body }
      } catch (err) {
        if (!(err instanceof XRPCError)) throw err
        return { status: err.statusCode, body: err.payload }
      }
    },
    close: () => rmSync(actorDir, { recursive: true, force: true }),
  }
}

/**
 * An unenroll that passed its enrollment check before a hold arrived must not
 * delete the row: the hold would go with it and the member could enroll again
 * as active. Shared by both backends.
 */
export function defineInFlightUnenrollScenarios(
  getBackend: () => HoldsBackend,
) {
  const open: Array<{ close: () => void | Promise<void> }> = []
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(open.splice(0).map((harness) => harness.close()))
  })

  function unenrollHarness(backend: HoldsBackend, locks?: RepoWriteLocks) {
    const harness = buildUnenrollHarness(backend, locks)
    open.push(harness)
    return harness
  }

  async function accountLabelHarness(backend: HoldsBackend) {
    const harness = await buildAccountLabelHarness(backend)
    open.push(harness)
    return harness
  }

  async function expectHeldAndUnableToEnroll(
    backend: HoldsBackend,
    did: string,
    hold: { operatorHold: boolean },
  ) {
    const row = await rowOf(backend, did)
    expect(row?.active).toBe(false)
    expect(row?.operatorHold).toBe(hold.operatorHold)
    expect(row?.boundaries.length).toBeGreaterThan(0)
    const again = await buildCallbackHarness(backend).complete(did)
    expect(again.status).toHaveBeenCalledWith(403)
    expect(again.json).toHaveBeenCalledWith(ENROLLMENT_DENIED_BODY)
    expect((await rowOf(backend, did))?.active).toBe(false)
  }

  it('a revoke past its check refuses once an operator hold lands and keeps the row', async () => {
    const backend = getBackend()
    const callback = buildCallbackHarness(backend)
    await seedMember(backend, { did: SPIKE_DID })
    await publishEnrollmentRecord(backend, callback.pds, SPIKE_DID)
    const atPds = pauseNextCall(callback.oauthClient.restore)
    const revoking = callback.revokeAs(SPIKE_DID)
    await atPds.reached

    expect(
      (await buildSetActiveHarness(backend).setActive(SPIKE_DID, false))
        .statusCode,
    ).toBe(200)
    atPds.resume()
    const res = await revoking

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(ENROLLMENT_DENIED_BODY)
    expect(callback.oauthClient.revoke).not.toHaveBeenCalled()
    expect(callback.pds.enrollmentRecord(SPIKE_DID)).toBeDefined()
    await expectHeldAndUnableToEnroll(backend, SPIKE_DID, {
      operatorHold: true,
    })
  })

  it('a revoke past its check refuses once an account takedown lands and keeps the row', async () => {
    const backend = getBackend()
    const callback = buildCallbackHarness(backend)
    const moderation = await accountLabelHarness(backend)
    await seedAccount(backend, { did: FAYE_DID })
    await publishEnrollmentRecord(backend, callback.pds, FAYE_DID)
    const atPds = pauseNextCall(callback.oauthClient.restore)
    const revoking = callback.revokeAs(FAYE_DID)
    await atPds.reached

    expect((await moderation.takedown(FAYE_DID)).status).toBe(200)
    atPds.resume()
    const res = await revoking

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(ENROLLMENT_DENIED_BODY)
    expect(callback.oauthClient.revoke).not.toHaveBeenCalled()
    expect(callback.pds.enrollmentRecord(FAYE_DID)).toBeDefined()
    expect(await moderation.labels()).toHaveLength(1)
    await expectHeldAndUnableToEnroll(backend, FAYE_DID, {
      operatorHold: false,
    })
  })

  it('a revoke waits for a hold that is being applied and then refuses', async () => {
    const backend = getBackend()
    const locks = new RepoWriteLocks()
    const callback = buildCallbackHarness(backend, locks)
    const { setActive } = buildSetActiveHarness(backend, locks)
    await seedMember(backend, { did: JET_DID })
    await publishEnrollmentRecord(backend, callback.pds, JET_DID)
    const atPds = pauseNextCall(callback.oauthClient.restore)
    const revoking = callback.revokeAs(JET_DID)
    await atPds.reached
    const insideHold = pauseNextStoreCall(backend.labelStore, 'latestTakedowns')
    const holding = setActive(JET_DID, false)
    await insideHold.reached

    atPds.resume()
    await settleBriefly()
    insideHold.resume()
    const [res, held] = await Promise.all([revoking, holding])

    expect(held.statusCode).toBe(200)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(ENROLLMENT_DENIED_BODY)
    expect(callback.pds.enrollmentRecord(JET_DID)).toBeDefined()
    await expectHeldAndUnableToEnroll(backend, JET_DID, { operatorHold: true })
  })

  it('an XRPC unenroll past its check refuses once an operator hold lands and keeps the row', async () => {
    const backend = getBackend()
    const harness = unenrollHarness(backend)
    await seedMember(backend, { did: SPIKE_DID })
    await publishEnrollmentRecord(backend, harness.pds, SPIKE_DID)
    const atSyncQueue = pauseNextCall(harness.pdsSyncWorker.cancel)
    const unenrolling = harness.unenrollAs(SPIKE_DID)
    await atSyncQueue.reached

    expect(
      (await buildSetActiveHarness(backend).setActive(SPIKE_DID, false))
        .statusCode,
    ).toBe(200)
    atSyncQueue.resume()
    const res = await unenrolling

    expect(res).toEqual({ status: 403, body: ENROLLMENT_DENIED_BODY })
    expect(harness.oauthClient.revoke).not.toHaveBeenCalled()
    expect(harness.pds.enrollmentRecord(SPIKE_DID)).toBeDefined()
    await expectHeldAndUnableToEnroll(backend, SPIKE_DID, {
      operatorHold: true,
    })
  })

  it('an XRPC unenroll past its check refuses once an account takedown lands and keeps the row', async () => {
    const backend = getBackend()
    const harness = unenrollHarness(backend)
    const moderation = await accountLabelHarness(backend)
    await seedAccount(backend, { did: FAYE_DID })
    await publishEnrollmentRecord(backend, harness.pds, FAYE_DID)
    const atSyncQueue = pauseNextCall(harness.pdsSyncWorker.cancel)
    const unenrolling = harness.unenrollAs(FAYE_DID)
    await atSyncQueue.reached

    expect((await moderation.takedown(FAYE_DID)).status).toBe(200)
    atSyncQueue.resume()
    const res = await unenrolling

    expect(res).toEqual({ status: 403, body: ENROLLMENT_DENIED_BODY })
    expect(harness.pds.enrollmentRecord(FAYE_DID)).toBeDefined()
    expect(await moderation.labels()).toHaveLength(1)
    await expectHeldAndUnableToEnroll(backend, FAYE_DID, {
      operatorHold: false,
    })
  })

  it('an XRPC unenroll still refuses and warns when the record cannot be republished', async () => {
    const backend = getBackend()
    const harness = unenrollHarness(backend)
    await seedMember(backend, { did: SPIKE_DID })
    await publishEnrollmentRecord(backend, harness.pds, SPIKE_DID)
    const atSyncQueue = pauseNextCall(harness.pdsSyncWorker.cancel)
    const unenrolling = harness.unenrollAs(SPIKE_DID)
    await atSyncQueue.reached

    expect(
      (await buildSetActiveHarness(backend).setActive(SPIKE_DID, false))
        .statusCode,
    ).toBe(200)
    vi.spyOn(backend.pdsSyncQueue, 'upsertPending').mockRejectedValueOnce(
      new Error('Gate of Babylon closed'),
    )
    atSyncQueue.resume()
    const res = await unenrolling

    expect(res).toEqual({ status: 403, body: ENROLLMENT_DENIED_BODY })
    expect(harness.pds.enrollmentRecord(SPIKE_DID)).toBeUndefined()
    expect(harness.logger.warn).toHaveBeenCalledWith(
      { err: 'Gate of Babylon closed', did: SPIKE_DID },
      'failed to republish PDS enrollment record after a refused unenrollment',
    )
    await expectHeldAndUnableToEnroll(backend, SPIKE_DID, {
      operatorHold: true,
    })
  })

  it('an XRPC unenroll waits for a hold that is being applied and then refuses', async () => {
    const backend = getBackend()
    const locks = new RepoWriteLocks()
    const harness = unenrollHarness(backend, locks)
    const { setActive } = buildSetActiveHarness(backend, locks)
    await seedMember(backend, { did: JET_DID })
    await publishEnrollmentRecord(backend, harness.pds, JET_DID)
    const atSyncQueue = pauseNextCall(harness.pdsSyncWorker.cancel)
    const unenrolling = harness.unenrollAs(JET_DID)
    await atSyncQueue.reached
    const insideHold = pauseNextStoreCall(backend.labelStore, 'latestTakedowns')
    const holding = setActive(JET_DID, false)
    await insideHold.reached

    atSyncQueue.resume()
    await settleBriefly()
    insideHold.resume()
    const [res, held] = await Promise.all([unenrolling, holding])

    expect(held.statusCode).toBe(200)
    expect(res).toEqual({ status: 403, body: ENROLLMENT_DENIED_BODY })
    expect(harness.pds.enrollmentRecord(JET_DID)).toBeDefined()
    await expectHeldAndUnableToEnroll(backend, JET_DID, { operatorHold: true })
  })

  it('an XRPC unenroll of an active member still deletes the row', async () => {
    const backend = getBackend()
    const harness = unenrollHarness(backend)
    await seedMember(backend, { did: ED_DID })
    await publishEnrollmentRecord(backend, harness.pds, ED_DID)

    const res = await harness.unenrollAs(ED_DID)

    expect(res).toEqual({ status: 200, body: { success: true } })
    expect(await rowOf(backend, ED_DID)).toBeNull()
    expect(harness.pds.enrollmentRecord(ED_DID)).toBeUndefined()
    expect(harness.oauthClient.revoke).toHaveBeenCalledWith(ED_DID)
  })

  it('a revoke of an active member still deletes the row', async () => {
    const backend = getBackend()
    const callback = buildCallbackHarness(backend)
    await seedMember(backend, { did: ED_DID })
    await publishEnrollmentRecord(backend, callback.pds, ED_DID)

    const res = await callback.revokeAs(ED_DID)

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ did: ED_DID, revoked: true }),
    )
    expect(await rowOf(backend, ED_DID)).toBeNull()
    expect(callback.pds.enrollmentRecord(ED_DID)).toBeUndefined()
  })
}
