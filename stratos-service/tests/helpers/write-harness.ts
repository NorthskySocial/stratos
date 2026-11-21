import { mkdir, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { decode as cborDecode } from '@atproto/lex-cbor'
import { isTypedLexMap } from '@atproto/lex-data'
import { AtUri } from '@atproto/syntax'
import {
  boundaryToSpaceUri,
  type EnrollmentStoreWriter,
  type BoundaryDefinition,
  type Logger,
  type RecordWithMeta,
  type StatusAttr,
} from '@northskysocial/stratos-core'
import { registerHandlers } from '../../src/api/handlers.js'
import { createAppContext, type AppContext } from '../../src/context.js'
import { DiskBlobStore } from '../../src/infra/blobstore/disk.js'
import { applyEnrollmentHolds } from '../../src/features/enrollment/holds.js'
import { mintSpaceCredential as mintSignedSpaceCredential } from '../../src/features/space-credential/minter.js'
import { ADMIN_SESSION_COOKIE } from '../../src/oauth/admin-routes.js'
import { HOSTED_SPACE_TYPE } from '../../src/shared/space-type-registry.js'
import { decodeEvent, type SeqEvent } from '../../src/subscription/index.js'
import { createTestConfig } from '../utils/index.js'

export const HARNESS_SERVICE_DID = 'did:web:nerv.tokyo.jp'
export const HARNESS_ENGINEERING = `${HARNESS_SERVICE_DID}/engineering`
export const HARNESS_DESIGN = `${HARNESS_SERVICE_DID}/design`
export const HARNESS_LEADERSHIP = `${HARNESS_SERVICE_DID}/leadership`
export const HARNESS_GENERAL = `${HARNESS_SERVICE_DID}/general`

const ADMIN_DID = 'did:plc:gendo-ikari'
const ADMIN_SESSION_LIFETIME_MS = 60_000
const PDS_ENDPOINT = 'https://pds.nerv.tokyo.jp'
const CREDENTIAL_LIFETIME_SECONDS = 600
const READ_LIMIT = 1000

/** The value of the Authorization header, or null to send none. */
export type CallAuth = string | null

export interface CallResult {
  status: number
  body: unknown
}

export interface SequencedOp {
  seq: number
  action: string
  path: string
  /** The boundaries the op is delivered to: its own scope, else its record's. */
  scope: string[]
  /** The boundaries a subscriber must not share for this op to reach it. */
  exclude: string[]
}

export interface RecordRows {
  record: RecordWithMeta | null
  boundaries: string[]
  takedown: StatusAttr | null
}

export interface RepoRoot {
  cid: string
  rev: string
}

export interface WriteHarness {
  ctx: AppContext
  baseUrl: string
  enrollMember(did: string, boundaries: string[]): Promise<void>
  enrollServiceIdentity(did: string, boundaries: string[]): Promise<void>
  enrollPdsCustodyMember(did: string, boundaries: string[]): Promise<void>
  /**
   * Enrolls an identity that has no repo in boundaries, listing in the catalog
   * any the harness does not already know. For tests that need many distinct
   * boundaries cheaply.
   */
  enrollBoundaryHolder(did: string, boundaries: string[]): Promise<void>
  holdMember(did: string): Promise<void>
  removeBoundary(did: string, boundary: string): Promise<CallResult>
  mintSpaceCredential(did: string, boundary: string): Promise<string>
  call(nsid: string, auth: CallAuth, body: unknown): Promise<CallResult>
  query(
    nsid: string,
    auth: CallAuth,
    params: Record<string, string>,
  ): Promise<CallResult>
  sequencedOps(did: string): Promise<SequencedOp[]>
  recordRows(uri: string): Promise<RecordRows>
  repoRoot(did: string): Promise<RepoRoot | null>
  close(): Promise<void>
}

/** The Authorization header the dev-mode verifier reads as a member's identity. */
export function asMember(did: string): CallAuth {
  return `Bearer ${did}`
}

/** A Bearer header carrying a space credential. */
export function withCredential(credential: string): CallAuth {
  return `Bearer ${credential}`
}

type HarnessStorage =
  | { backend: 'sqlite' }
  | { backend: 'postgres'; connectionString: string }

export interface WriteHarnessOptions {
  /** Replaces the silent logger, for tests that read what the service logs. */
  logger?: Logger
}

export function startSqliteWriteHarness(
  options: WriteHarnessOptions = {},
): Promise<WriteHarness> {
  return startWriteHarness({ backend: 'sqlite' }, options)
}

export function startPostgresWriteHarness(
  connectionString: string,
): Promise<WriteHarness> {
  return startWriteHarness({ backend: 'postgres', connectionString })
}

function cborToRecord(bytes: Uint8Array): Record<string, unknown> {
  const data = cborDecode(bytes)
  if (isTypedLexMap(data)) return data
  throw new Error('Expected record with $type property')
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

async function startWriteHarness(
  storage: HarnessStorage,
  options: WriteHarnessOptions = {},
): Promise<WriteHarness> {
  const dataDir = join(
    tmpdir(),
    `stratos-write-harness-${randomBytes(8).toString('hex')}`,
  )
  await mkdir(dataDir, { recursive: true })

  const base = createTestConfig(dataDir)
  const ctx = await createAppContext({
    cfg: {
      ...base,
      service: { ...base.service, did: HARNESS_SERVICE_DID },
      storage:
        storage.backend === 'postgres'
          ? {
              backend: 'postgres',
              dataDir,
              postgresUrl: storage.connectionString,
              pgActorPoolSize: 5,
              pgAdminPoolSize: 2,
            }
          : { backend: 'sqlite', dataDir },
      stratos: {
        ...base.stratos,
        serviceDid: HARNESS_SERVICE_DID,
        allowedDomains: [
          HARNESS_ENGINEERING,
          HARNESS_DESIGN,
          HARNESS_LEADERSHIP,
          HARNESS_GENERAL,
        ],
        reservedDomain: HARNESS_GENERAL,
        devMode: true,
      },
      adminDids: [ADMIN_DID],
    },
    blobstore: DiskBlobStore.creator(join(dataDir, 'blobs')),
    cborToRecord,
    logger: options.logger ?? silentLogger,
  })

  registerHandlers(ctx.xrpcServer, ctx)
  ctx.app.use(ctx.xrpcServer.router)
  const httpServer: Server = await new Promise((resolve) => {
    const listening = ctx.app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`

  const enrolled = new Set<string>()

  async function enroll(
    did: string,
    boundaries: string[],
    extra: Partial<Parameters<EnrollmentStoreWriter['enroll']>[0]>,
    signingKeyDid: string,
  ): Promise<void> {
    await ctx.enrollmentStore.enroll({
      did,
      enrolledAt: new Date().toISOString(),
      pdsEndpoint: PDS_ENDPOINT,
      signingKeyDid,
      active: true,
      boundaries,
      ...extra,
    })
    enrolled.add(did)
  }

  async function callXrpc(
    nsid: string,
    auth: CallAuth,
    body: unknown,
  ): Promise<CallResult> {
    return post(
      `${baseUrl}/xrpc/${nsid}`,
      auth ? { authorization: auth } : {},
      body,
    )
  }

  return {
    ctx,
    baseUrl,

    async enrollMember(did, boundaries) {
      await ctx.actorStore.create(did)
      const signingKeyDid = await ctx.actorSigner.getPublicKey(did)
      await enroll(did, boundaries, { custody: 'stratos' }, signingKeyDid)
    },

    async enrollServiceIdentity(did, boundaries) {
      await enroll(did, boundaries, { isService: true }, did)
    },

    async enrollPdsCustodyMember(did, boundaries) {
      await enroll(
        did,
        boundaries,
        { custody: 'pds', repoHost: PDS_ENDPOINT },
        did,
      )
    },

    async enrollBoundaryHolder(did, boundaries) {
      for (const boundary of boundaries) {
        if (!(await ctx.boundaryStore?.get(boundary))) {
          await ctx.boundaryStore?.create(activeDefinition(boundary))
        }
      }
      await enroll(did, [...new Set(boundaries)], { custody: 'stratos' }, did)
    },

    async holdMember(did) {
      await applyEnrollmentHolds(ctx, did, { operatorHold: true })
    },

    async removeBoundary(did, boundary) {
      const session = await ctx.adminSessionStore.create(
        ADMIN_DID,
        ADMIN_SESSION_LIFETIME_MS,
      )
      return post(
        `${baseUrl}/xrpc/zone.stratos.admin.removeBoundary`,
        { cookie: `${ADMIN_SESSION_COOKIE}=${session}` },
        { did, boundary },
      )
    },

    async mintSpaceCredential(did, boundary) {
      const memberBoundaries = await ctx.enrollmentStore.getBoundaries(did)
      if (!memberBoundaries.includes(boundary)) {
        throw new Error(`${did} is not a member of ${boundary}`)
      }
      const space = boundaryToSpaceUri(boundary, HOSTED_SPACE_TYPE)
      if (!space.ok) throw new Error(space.error.message)
      const definition = await ctx.boundaryStore?.get(boundary)
      const { credential } = await mintSignedSpaceCredential({
        signingKey: ctx.signingKey,
        issuerDid: ctx.serviceDid,
        spaceUri: space.value,
        ttlSeconds: CREDENTIAL_LIFETIME_SECONDS,
        boundaryRevision: definition?.revision,
      })
      return credential
    },

    call: callXrpc,

    async query(nsid, auth, params) {
      const response = await fetch(
        `${baseUrl}/xrpc/${nsid}?${new URLSearchParams(params)}`,
        { headers: auth ? { authorization: auth } : {} },
      )
      const text = await response.text()
      return { status: response.status, body: text ? parseJson(text) : null }
    },

    async sequencedOps(did) {
      const events = await ctx.actorStore.read(did, async (store) => {
        const rows = await store.sequence.getEventsSince(0, READ_LIMIT)
        return rows.map(
          (row): SeqEvent => ({
            seq: row.seq,
            did: row.did,
            time: row.sequencedAt,
            rev: '',
            event: row.event,
          }),
        )
      })
      return events.flatMap((event) =>
        decodeEvent(event).ops.map((op) => describeOp(event, op)),
      )
    },

    async recordRows(uri) {
      const did = new AtUri(uri).hostname
      return ctx.actorStore.read(did, async (store) => ({
        record: await store.record.getRecord(uri, null, true),
        boundaries: await store.record.getRecordBoundaries(uri),
        takedown: await store.record.getRecordTakedownStatus(uri),
      }))
    },

    async repoRoot(did) {
      const root = await ctx.actorStore.read(did, (store) =>
        store.repo.getRootDetailed(),
      )
      return root ? { cid: root.cid.toString(), rev: root.rev } : null
    },

    async close() {
      await new Promise((resolve) => httpServer.close(resolve))
      for (const did of enrolled) {
        await ctx.enrollmentStore.unenroll(did)
        if (await ctx.actorStore.exists(did)) await ctx.actorStore.destroy(did)
      }
      await ctx.destroy()
      // The context's own teardown ends only the service pool; the actor
      // store owns two more pools it never closes.
      await ctx.actorStore.close?.()
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

function activeDefinition(boundary: string): BoundaryDefinition {
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

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<CallResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text ? parseJson(text) : null }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

interface DecodedOp {
  action: string
  path: string
  boundary?: { values: Array<{ value: string }> }
  excludeBoundary?: { values: Array<{ value: string }> }
  record?: { boundary?: { values: Array<{ value: string }> } }
}

function describeOp(event: SeqEvent, rawOp: unknown): SequencedOp {
  const op = rawOp as DecodedOp
  const names = (set?: { values: Array<{ value: string }> }) =>
    set?.values.map((entry) => entry.value) ?? []
  return {
    seq: event.seq,
    action: op.action,
    path: op.path,
    scope: names(op.boundary ?? op.record?.boundary),
    exclude: names(op.excludeBoundary),
  }
}
