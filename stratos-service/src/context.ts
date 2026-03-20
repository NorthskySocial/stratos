import path from 'node:path'
import fs from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import express from 'express'
import { eq, gt, asc, desc, sql } from 'drizzle-orm'
import * as crypto from '@atproto/crypto'
import { IdResolver } from '@atproto/identity'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import {
  Server as XrpcServer,
  XRPCError,
  AuthRequiredError,
  InvalidRequestError,
  type StreamAuthVerifier,
  type StreamAuthContext,
} from '@atproto/xrpc-server'
import { schemas as atprotoSchemas, Agent } from '@atproto/api'
import type { LexiconDoc } from '@atproto/lexicon'
import { fileExists } from '@atproto/common'
import { verifyServiceAuth } from './auth/verifier.js'

import {
  createStratosDb,
  migrateStratosDb,
  closeStratosDb,
  stratosSeq,
  type StratosDbOrTx,
  StratosRecordReader,
  StratosRecordTransactor,
  StratosSqlRepoReader,
  StratosSqlRepoTransactor,
  StratosBlobReader,
  StratosBlobTransactor,
  type BlobStore,
  type BlobStoreCreator,
  type Logger,
  type EnrollmentService,
  type BoundaryResolver,
  type StubWriterService,
  type EnrollmentStoreReader,
  type StoredEnrollment,
  type ListEnrollmentsOptions,
  createAttestationPayload,
  buildCommit,
} from '@northskysocial/stratos-core'
import type {
  SequenceOperations,
  ActorReader,
  ActorTransactor,
  ActorStore,
} from './actor-store-types.js'
import {
  EnrollmentServiceImpl,
  EnrollmentBoundaryResolver,
  PdsAgent,
  ExternalAllowListProvider,
} from './features/index.js'
import { StubWriterServiceImpl, BackgroundStubQueue } from './features/index.js'
import {
  StratosBlockStoreReader,
  signAndPersistCommit,
} from './features/index.js'

import {
  type StratosServiceConfig,
  getServiceDidWithFragment,
} from './config.js'
import {
  createOAuthClient,
  OAUTH_SCOPE,
  createSqliteOAuthStores,
  createPgOAuthStores,
} from './oauth/client.js'
import { type EnrollmentStore, type EnrollmentRecord } from './oauth/routes.js'
import {
  createServiceDb,
  migrateServiceDb,
  closeServiceDb,
  type ServiceDb,
  enrollment,
  enrollmentBoundary,
} from './db/index.js'
import {
  PdsTokenVerifier,
  DpopVerifier,
  DpopVerificationError,
} from './auth/index.js'
import {
  createServicePgDb,
  checkServicePgDbStartup,
  migrateServicePgDb,
  closeServicePgDb,
} from './db/pg.js'
import { PgEnrollmentStoreWriter } from './adapters/index.js'
import { PostgresActorStore } from './adapters/index.js'
import { CachedEnrollmentStore } from './adapters/cached-enrollment-store.js'
import { buildUserAgent, createFetchWithUserAgent } from './user-agent.js'
import { VERSION } from './version.js'
import { RedisCache } from './adapters/redis-cache.js'

/**
 * Actor store manager for Stratos
 */
class SqliteSequenceOps implements SequenceOperations {
  constructor(private db: StratosDbOrTx) {}

  async getLatestSeq(): Promise<number> {
    const rows = await this.db
      .select({ seq: stratosSeq.seq })
      .from(stratosSeq)
      .orderBy(desc(stratosSeq.seq))
      .limit(1)
    return rows[0]?.seq ?? 0
  }

  async getOldestSeq(): Promise<number> {
    const rows = await this.db
      .select({ seq: stratosSeq.seq })
      .from(stratosSeq)
      .orderBy(asc(stratosSeq.seq))
      .limit(1)
    return rows[0]?.seq ?? 0
  }

  async getEventsSince(
    cursor: number,
    limit = 100,
  ): Promise<
    Array<{
      seq: number
      did: string
      eventType: string
      event: Buffer
      invalidated: number
      sequencedAt: string
    }>
  > {
    const rows = await this.db
      .select()
      .from(stratosSeq)
      .where(gt(stratosSeq.seq, cursor))
      .orderBy(asc(stratosSeq.seq))
      .limit(limit)
    return rows as Array<{
      seq: number
      did: string
      eventType: string
      event: Buffer
      invalidated: number
      sequencedAt: string
    }>
  }

  async appendEvent(event: {
    did: string
    eventType: string
    event: Buffer
    invalidated: number
    sequencedAt: string
  }): Promise<void> {
    await this.db.insert(stratosSeq).values(event)
  }
}

export class StratosActorStore implements ActorStore {
  private readonly dataDir: string
  private readonly blobstore: BlobStoreCreator
  private readonly logger?: Logger
  private readonly existsCache = new Set<string>()
  private readonly cborToRecord: (
    content: Uint8Array,
  ) => Record<string, unknown>

  constructor(opts: {
    dataDir: string
    blobstore: BlobStoreCreator
    logger?: Logger
    cborToRecord: (content: Uint8Array) => Record<string, unknown>
  }) {
    this.dataDir = opts.dataDir
    this.blobstore = opts.blobstore
    this.logger = opts.logger
    this.cborToRecord = opts.cborToRecord
  }

  async exists(did: string): Promise<boolean> {
    if (this.existsCache.has(did)) return true
    const { dbLocation } = await this.getLocation(did)
    const found = await fileExists(dbLocation)
    if (found) this.existsCache.add(did)
    return found
  }

  async create(did: string): Promise<void> {
    const { directory, dbLocation } = await this.getLocation(did)
    await fs.mkdir(directory, { recursive: true })

    const db = createStratosDb(dbLocation)
    try {
      await db._initialized
      await migrateStratosDb(db)
    } finally {
      await closeStratosDb(db)
    }
    this.existsCache.add(did)
  }

  async destroy(did: string): Promise<void> {
    const { directory } = await this.getLocation(did)
    await fs.rm(directory, { recursive: true, force: true })
    this.existsCache.delete(did)
  }

  async read<T>(
    did: string,
    fn: (store: ActorReader) => T | PromiseLike<T>,
  ): Promise<T> {
    const { dbLocation } = await this.getLocation(did)
    const db = createStratosDb(dbLocation)
    await db._initialized
    const blobStore = this.blobstore(did)

    try {
      const store: ActorReader = {
        did,
        record: new StratosRecordReader(db, this.cborToRecord, this.logger),
        repo: new StratosSqlRepoReader(db),
        blob: new StratosBlobReader(db, blobStore, this.logger),
        sequence: new SqliteSequenceOps(db),
      }
      return await fn(store)
    } finally {
      await closeStratosDb(db)
    }
  }

  async transact<T>(
    did: string,
    fn: (store: ActorTransactor) => T | PromiseLike<T>,
  ): Promise<T> {
    const { dbLocation } = await this.getLocation(did)
    const db = createStratosDb(dbLocation)
    await db._initialized
    const blobStore = this.blobstore(did)

    try {
      return await db.transaction(async (tx) => {
        const txDb = tx as unknown as StratosDbOrTx
        const store: ActorTransactor = {
          did,
          record: new StratosRecordTransactor(
            txDb,
            this.cborToRecord,
            this.logger,
          ),
          repo: new StratosSqlRepoTransactor(txDb),
          blob: new StratosBlobTransactor(txDb, blobStore, this.logger),
          sequence: new SqliteSequenceOps(txDb),
        }
        return fn(store)
      })
    } finally {
      await closeStratosDb(db)
    }
  }

  async readThenTransact<R, T>(
    did: string,
    readFn: (store: ActorReader) => R | PromiseLike<R>,
    transactFn: (
      readResult: Awaited<R>,
      store: ActorTransactor,
    ) => T | PromiseLike<T>,
  ): Promise<T> {
    const { dbLocation } = await this.getLocation(did)
    const db = createStratosDb(dbLocation)
    await db._initialized
    const blobStore = this.blobstore(did)

    try {
      const reader: ActorReader = {
        did,
        record: new StratosRecordReader(db, this.cborToRecord, this.logger),
        repo: new StratosSqlRepoReader(db),
        blob: new StratosBlobReader(db, blobStore, this.logger),
        sequence: new SqliteSequenceOps(db),
      }
      const readResult = (await readFn(reader)) as Awaited<R>

      return await db.transaction(async (tx) => {
        const txDb = tx as unknown as StratosDbOrTx
        const transactor: ActorTransactor = {
          did,
          record: new StratosRecordTransactor(
            txDb,
            this.cborToRecord,
            this.logger,
          ),
          repo: new StratosSqlRepoTransactor(txDb),
          blob: new StratosBlobTransactor(txDb, blobStore, this.logger),
          sequence: new SqliteSequenceOps(txDb),
        }
        return transactFn(readResult, transactor)
      })
    } finally {
      await closeStratosDb(db)
    }
  }

  getBlobStore(did: string): BlobStore {
    return this.blobstore(did)
  }

  async createSigningKey(did: string): Promise<crypto.P256Keypair> {
    const { directory } = await this.getLocation(did)
    const keyPath = path.join(directory, 'signing_key')
    const keypair = await crypto.P256Keypair.create({ exportable: true })
    const exported = await (keypair as crypto.ExportableKeypair).export()
    await fs.writeFile(keyPath, exported)
    return keypair
  }

  async loadSigningKey(did: string): Promise<crypto.P256Keypair | null> {
    const { directory } = await this.getLocation(did)
    const keyPath = path.join(directory, 'signing_key')
    if (!(await fileExists(keyPath))) {
      return null
    }
    const keyBytes = await fs.readFile(keyPath)
    return crypto.P256Keypair.import(keyBytes, { exportable: true })
  }

  async deleteSigningKey(did: string): Promise<void> {
    const { directory } = await this.getLocation(did)
    const keyPath = path.join(directory, 'signing_key')
    try {
      await fs.unlink(keyPath)
    } catch {
      // Key file may not exist
    }
  }

  private async getLocation(did: string) {
    const didHash = await crypto.sha256Hex(did)
    const directory = path.join(this.dataDir, didHash.slice(0, 2), did)
    const resolved = path.resolve(directory)
    if (!resolved.startsWith(path.resolve(this.dataDir))) {
      throw new Error('Invalid DID: resolved path escapes data directory')
    }
    const dbLocation = path.join(directory, 'stratos.sqlite')
    const blobLocation = path.join(directory, 'blobs')
    return { directory, dbLocation, blobLocation }
  }
}

/**
 * SQLite enrollment store implements both OAuth EnrollmentStore
 * and stratos-core EnrollmentStoreReader interfaces
 */
export class SqliteEnrollmentStore
  implements EnrollmentStore, EnrollmentStoreReader
{
  constructor(private db: ServiceDb) {}

  async isEnrolled(did: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(enrollment)
      .where(eq(enrollment.did, did))
      .limit(1)

    return rows.length > 0 && rows[0].active === 'true'
  }

  async enroll(record: EnrollmentRecord): Promise<void> {
    await this.db
      .insert(enrollment)
      .values({
        did: record.did,
        enrolledAt: record.enrolledAt,
        pdsEndpoint: record.pdsEndpoint ?? null,
        signingKeyDid: record.signingKeyDid,
        active: record.active ? 'true' : 'false',
        enrollmentRkey: record.enrollmentRkey ?? null,
      })
      .onConflictDoUpdate({
        target: enrollment.did,
        set: {
          enrolledAt: record.enrolledAt,
          pdsEndpoint: record.pdsEndpoint ?? null,
          signingKeyDid: record.signingKeyDid,
          active: record.active ? 'true' : 'false',
          enrollmentRkey: record.enrollmentRkey ?? null,
        },
      })

    if (record.boundaries && record.boundaries.length > 0) {
      await this.db
        .delete(enrollmentBoundary)
        .where(eq(enrollmentBoundary.did, record.did))

      await this.db
        .insert(enrollmentBoundary)
        .values(
          record.boundaries.map((boundary) => ({ did: record.did, boundary })),
        )
    }
  }

  async unenroll(did: string): Promise<void> {
    await this.db
      .delete(enrollmentBoundary)
      .where(eq(enrollmentBoundary.did, did))

    await this.db
      .update(enrollment)
      .set({ active: 'false' })
      .where(eq(enrollment.did, did))
  }

  async getEnrollment(did: string): Promise<StoredEnrollment | null> {
    const rows = await this.db
      .select()
      .from(enrollment)
      .where(eq(enrollment.did, did))
      .limit(1)

    const row = rows[0]
    if (!row) return null

    return {
      did: row.did,
      enrolledAt: row.enrolledAt,
      pdsEndpoint: row.pdsEndpoint ?? undefined,
      signingKeyDid: row.signingKeyDid,
      active: row.active === 'true',
      enrollmentRkey: row.enrollmentRkey ?? undefined,
    }
  }

  async updateEnrollment(
    did: string,
    updates: Partial<Omit<EnrollmentRecord, 'did'>>,
  ): Promise<void> {
    const setValues: Record<string, unknown> = {}
    if (updates.enrolledAt !== undefined)
      setValues.enrolledAt = updates.enrolledAt
    if (updates.pdsEndpoint !== undefined)
      setValues.pdsEndpoint = updates.pdsEndpoint
    if (updates.signingKeyDid !== undefined)
      setValues.signingKeyDid = updates.signingKeyDid
    if (updates.active !== undefined)
      setValues.active = updates.active ? 'true' : 'false'
    if (updates.enrollmentRkey !== undefined)
      setValues.enrollmentRkey = updates.enrollmentRkey

    if (Object.keys(setValues).length > 0) {
      await this.db
        .update(enrollment)
        .set(setValues)
        .where(eq(enrollment.did, did))
    }
  }

  async listEnrollments(
    options?: ListEnrollmentsOptions,
  ): Promise<StoredEnrollment[]> {
    const limit = options?.limit ?? 100
    const cursor = options?.cursor

    let query = this.db.select().from(enrollment)

    if (cursor) {
      query = query.where(gt(enrollment.did, cursor)) as typeof query
    }

    const rows = await query.orderBy(asc(enrollment.did)).limit(limit)

    return rows.map((row) => ({
      did: row.did,
      enrolledAt: row.enrolledAt,
      pdsEndpoint: row.pdsEndpoint ?? undefined,
      signingKeyDid: row.signingKeyDid,
      active: row.active === 'true',
      enrollmentRkey: row.enrollmentRkey ?? undefined,
    }))
  }

  async enrollmentCount(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(enrollment)

    return rows[0]?.count ?? 0
  }

  async getBoundaries(did: string): Promise<string[]> {
    const rows = await this.db
      .select({ boundary: enrollmentBoundary.boundary })
      .from(enrollmentBoundary)
      .where(eq(enrollmentBoundary.did, did))

    return rows.map((r) => r.boundary)
  }
}

/**
 * Auth verifier collection for different auth scenarios
 */
export interface AuthVerifiers {
  /** Standard user auth (OAuth token) */
  standard: (
    ctx: import('@atproto/xrpc-server').MethodAuthContext,
  ) => Promise<{ credentials: { type: string; did: string } }>
  /** Service-to-service auth (inter-service JWT) */
  service: (
    ctx: import('@atproto/xrpc-server').MethodAuthContext,
  ) => Promise<{ credentials: { type: string; did: string; iss: string } }>
  /** Optional user auth */
  optionalStandard: (
    ctx: import('@atproto/xrpc-server').MethodAuthContext,
  ) => Promise<{ credentials: { type: string; did?: string } }>
  /** Admin auth (basic auth or bearer token with admin password) */
  admin: (
    ctx: import('@atproto/xrpc-server').MethodAuthContext,
  ) => Promise<{ credentials: { type: string } }>
  /** Stream auth for zone.stratos.sync.subscribeRecords */
  subscribeAuth: StreamAuthVerifier
}

/**
 * Timing-safe string comparison to prevent timing attacks on credentials
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) {
    // Compare against self to consume constant time, then return false
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

/**
 * Create auth verifiers for the application
 */
function createAuthVerifiers(
  serviceDid: string,
  idResolver: IdResolver,
  _oauthClient: NodeOAuthClient,
  enrollmentStore: EnrollmentStore,
  adminPassword: string | undefined,
  dpopVerifier: import('./auth/dpop-verifier.js').DpopVerifier,
  allowListProvider: ExternalAllowListProvider | undefined,
  devMode: boolean,
  syncToken: string | undefined,
): AuthVerifiers {
  return {
    standard: async (ctx) => {
      const authHeader = ctx.req?.headers?.authorization
      if (!authHeader) {
        throw new Error('Authorization required')
      }

      if (devMode && authHeader.startsWith('Bearer ')) {
        const did = authHeader.slice(7).trim()
        if (did.startsWith('did:')) {
          const isEnrolled = await enrollmentStore.isEnrolled(did)
          const isAllowed = allowListProvider
            ? await allowListProvider.isAllowed(did)
            : true
          if (isEnrolled && isAllowed) {
            return { credentials: { type: 'user', did } }
          }
        }
        throw new Error('Authorization failed')
      }

      if (!authHeader.startsWith('DPoP ') || !dpopVerifier) {
        throw new Error('DPoP authorization required')
      }

      try {
        const result = await dpopVerifier.verify(
          {
            method: ctx.req.method || 'GET',
            url: ctx.req.url || '/',
            headers: ctx.req.headers as Record<
              string,
              string | string[] | undefined
            >,
          },
          {
            setHeader: (name, value) => ctx.res?.setHeader(name, value),
          },
        )
        return {
          credentials: { type: 'user', did: result.did },
        }
      } catch (err) {
        if (err instanceof DpopVerificationError && err.wwwAuthenticate) {
          ctx.res?.setHeader('WWW-Authenticate', err.wwwAuthenticate)
        }

        if (
          err instanceof DpopVerificationError &&
          err.code === 'not_enrolled'
        ) {
          throw new InvalidRequestError(
            'User is not enrolled in this Stratos service',
            'NotEnrolled',
          )
        }

        const message =
          err instanceof Error ? err.message : 'DPoP verification failed'
        throw new XRPCError(401, message)
      }
    },
    service: async (ctx) => {
      const authHeader = ctx.req?.headers?.authorization
      if (!authHeader) {
        throw new Error('Service authorization required')
      }
      const serviceCtx = await verifyServiceAuth(
        authHeader,
        serviceDid,
        undefined,
        idResolver,
      )
      return {
        credentials: {
          type: 'service',
          did: serviceCtx.iss,
          iss: serviceCtx.iss,
        },
      }
    },
    optionalStandard: async (ctx) => {
      const authHeader = ctx.req?.headers?.authorization
      if (!authHeader) {
        return { credentials: { type: 'none' } }
      }

      if (devMode && authHeader.startsWith('Bearer ')) {
        const did = authHeader.slice(7).trim()
        if (did.startsWith('did:')) {
          const isEnrolled = await enrollmentStore.isEnrolled(did)
          const isAllowed = allowListProvider
            ? await allowListProvider.isAllowed(did)
            : true
          if (isEnrolled && isAllowed) {
            return { credentials: { type: 'user', did } }
          }
        }
        return { credentials: { type: 'none' } }
      }

      // Try service auth (Bearer JWT from AppView/indexer)
      if (authHeader.startsWith('Bearer ')) {
        try {
          const serviceCtx = await verifyServiceAuth(
            authHeader,
            serviceDid,
            undefined,
            idResolver,
          )
          return {
            credentials: {
              type: 'service',
              did: serviceCtx.iss,
            },
          }
        } catch {
          return { credentials: { type: 'none' } }
        }
      }

      if (!authHeader.startsWith('DPoP ') || !dpopVerifier) {
        return { credentials: { type: 'none' } }
      }

      try {
        const result = await dpopVerifier.verify(
          {
            method: ctx.req.method || 'GET',
            url: ctx.req.url || '/',
            headers: ctx.req.headers as Record<
              string,
              string | string[] | undefined
            >,
          },
          {
            setHeader: (name, value) => ctx.res?.setHeader(name, value),
          },
        )
        return {
          credentials: { type: 'user', did: result.did },
        }
      } catch (err) {
        // DPoP auth was attempted — propagate errors so clients can
        // participate in nonce negotiation and see real auth failures
        if (err instanceof DpopVerificationError && err.wwwAuthenticate) {
          ctx.res?.setHeader('WWW-Authenticate', err.wwwAuthenticate)
        }
        const message =
          err instanceof Error ? err.message : 'DPoP verification failed'
        throw new XRPCError(401, message)
      }
    },
    admin: async (ctx) => {
      const authHeader = ctx.req?.headers?.authorization
      if (!authHeader) {
        throw new Error('Admin authorization required')
      }
      if (!adminPassword) {
        throw new Error('Admin auth not configured')
      }

      if (authHeader.startsWith('Basic ')) {
        // Parse Basic auth: base64(admin:<password>)
        const encoded = authHeader.slice(6)
        const decoded = Buffer.from(encoded, 'base64').toString('utf8')
        const [user, pass] = decoded.split(':')
        if (
          !safeEqual(user ?? '', 'admin') ||
          !safeEqual(pass ?? '', adminPassword)
        ) {
          throw new Error('Invalid admin credentials')
        }
      } else if (authHeader.startsWith('Bearer ')) {
        // Simple bearer token: just the password
        const token = authHeader.slice(7)
        if (!safeEqual(token, adminPassword)) {
          throw new Error('Invalid admin token')
        }
      } else {
        throw new Error('Unsupported authorization type')
      }

      return {
        credentials: { type: 'admin' },
      }
    },
    subscribeAuth: async (ctx: StreamAuthContext) => {
      const params = ctx.params as Record<string, unknown>
      const tokenParam = params.syncToken

      console.log('[subscribeAuth] request received', {
        hasSyncToken: !!tokenParam,
        hasServerToken: !!syncToken,
        url: ctx.req.url,
      })

      if (tokenParam && typeof tokenParam === 'string' && syncToken) {
        if (safeEqual(tokenParam, syncToken)) {
          console.log('[subscribeAuth] sync token matched')
          return {
            credentials: {
              type: 'service',
              iss: 'sync-token',
              aud: serviceDid,
            },
          }
        }
        console.log('[subscribeAuth] sync token mismatch')
      }

      if (tokenParam && typeof tokenParam === 'string') {
        const serviceCtx = await verifyServiceAuth(
          `Bearer ${tokenParam}`,
          serviceDid,
          'zone.stratos.sync.subscribeRecords',
          idResolver,
        )
        return {
          credentials: {
            type: 'service',
            iss: serviceCtx.iss,
            aud: serviceCtx.aud,
          },
        }
      }

      const authHeader = ctx.req.headers.authorization
      if (authHeader) {
        if (devMode && authHeader.startsWith('Bearer ')) {
          const did = authHeader.slice(7).trim()
          if (did.startsWith('did:')) {
            const isEnrolled = await enrollmentStore.isEnrolled(did)
            if (isEnrolled) {
              return { credentials: { type: 'user', did } }
            }
          }
          throw new AuthRequiredError('Authorization failed')
        }

        if (authHeader.startsWith('DPoP ') && dpopVerifier) {
          const result = await dpopVerifier.verify(
            {
              method: ctx.req.method || 'GET',
              url: ctx.req.url || '/',
              headers: ctx.req.headers as Record<
                string,
                string | string[] | undefined
              >,
            },
            { setHeader: () => {} },
          )
          return { credentials: { type: 'user', did: result.did } }
        }
      }

      throw new AuthRequiredError(
        'syncToken query param or Authorization header required',
      )
    },
  }
}

/**
 * Application context for Stratos service
 */
export interface AppContext {
  cfg: StratosServiceConfig
  version: string
  db?: ServiceDb
  actorStore: ActorStore
  enrollmentStore: EnrollmentStore
  enrollmentService: EnrollmentService
  boundaryResolver: BoundaryResolver
  stubWriter: StubWriterService
  stubQueue: BackgroundStubQueue
  authVerifier: AuthVerifiers
  idResolver: IdResolver
  oauthClient: NodeOAuthClient
  signingKey: crypto.Keypair
  signingDidKey: string
  serviceDid: string
  allowListProvider?: ExternalAllowListProvider
  xrpcServer: XrpcServer
  app: express.Application
  logger?: Logger
  createAttestation(
    did: string,
    boundaries: string[],
    userDidKey: string,
  ): Promise<{ sig: Uint8Array; signingKey: string }>
  dpopVerifier: import('./auth/dpop-verifier.js').DpopVerifier
  enrollmentEvents: EnrollmentEventEmitter
  destroy: () => Promise<void>
}

export interface EnrollmentEvent {
  did: string
  action: 'enroll' | 'unenroll'
  service?: string
  boundaries?: string[]
  time: string
}

export type EnrollmentEventEmitter = EventEmitter<{
  enrollment: [EnrollmentEvent]
}>

/**
 * Application context options
 */
export interface AppContextOptions {
  cfg: StratosServiceConfig
  blobstore: BlobStoreCreator
  cborToRecord: (content: Uint8Array) => Record<string, unknown>
  logger?: Logger
}

/**
 * Load Stratos lexicon documents from the lexicons directory
 */
export function loadStratosLexicons(): LexiconDoc[] {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  // From stratos-service/src/context.ts, lexicons are at ../../lexicons (relative to stratos-service)
  // In Docker, we're in /app/stratos-service, lexicons are at /app/lexicons
  const lexiconsDir = path.resolve(__dirname, '../..', 'lexicons')
  const lexicons: LexiconDoc[] = []

  function loadFromDir(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        loadFromDir(fullPath)
      } else if (entry.name.endsWith('.json')) {
        const content = readFileSync(fullPath, 'utf-8')
        const doc = JSON.parse(content) as LexiconDoc
        lexicons.push(doc)
      }
    }
  }

  loadFromDir(lexiconsDir)
  return lexicons
}

/**
 * Create application context
 */
export async function createAppContext(
  opts: AppContextOptions,
): Promise<AppContext> {
  const { cfg, blobstore, cborToRecord, logger } = opts

  const userAgent = buildUserAgent(
    VERSION,
    cfg.userAgent.repoUrl,
    cfg.userAgent.operatorContact,
  )
  const fetchWithUserAgent = createFetchWithUserAgent(userAgent)

  const serviceDbPath = path.join(cfg.storage.dataDir, 'service.sqlite')
  await fs.mkdir(cfg.storage.dataDir, { recursive: true })

  let db: ServiceDb | undefined
  let enrollmentStore: EnrollmentStore & EnrollmentStoreReader
  let oauthStores: {
    sessionStore: import('./oauth/client.js').OAuthSessionStoreBackend
    stateStore: import('./oauth/client.js').OAuthStateStoreBackend
  }
  let destroyBackend: () => Promise<void>

  if (cfg.storage.backend === 'postgres') {
    if (!cfg.storage.postgresUrl) {
      throw new Error(
        'STRATOS_POSTGRES_URL is required when backend is postgres',
      )
    }
    const pgDb = createServicePgDb(cfg.storage.postgresUrl)
    const pgStartup = await checkServicePgDbStartup(pgDb)
    logger?.info(
      {
        database: pgStartup.currentDatabase,
        user: pgStartup.currentUser,
        schema: pgStartup.currentSchema,
        searchPath: pgStartup.searchPath,
        hasDatabaseCreate: pgStartup.hasDatabaseCreate,
        hasSchemaUsage: pgStartup.hasSchemaUsage,
        hasSchemaCreate: pgStartup.hasSchemaCreate,
      },
      'postgres service database preflight passed',
    )
    await migrateServicePgDb(pgDb)
    const pgEnrollmentStore = new PgEnrollmentStoreWriter(pgDb)
    const cachedEnrollmentStore = new CachedEnrollmentStore(pgEnrollmentStore, {
      cacheTtlMs: 5 * 60 * 1000,
    })
    await cachedEnrollmentStore.warm()
    enrollmentStore = cachedEnrollmentStore
    oauthStores = createPgOAuthStores(pgDb)
    destroyBackend = async () => {
      await closeServicePgDb(pgDb)
    }
  } else {
    db = createServiceDb(serviceDbPath)
    await migrateServiceDb(db)
    enrollmentStore = new SqliteEnrollmentStore(db)
    oauthStores = createSqliteOAuthStores(db)
    destroyBackend = async () => {
      await closeServiceDb(db!)
    }
  }

  const idResolver = new IdResolver({
    plcUrl: cfg.identity.plcUrl,
  })

  const originalResolve = idResolver.handle.resolve.bind(idResolver.handle)
  idResolver.handle.resolve = async (handle: string) => {
    try {
      const result = await originalResolve(handle)
      if (result) return result
    } catch (err) {
      logger?.debug(
        { handle, err: err instanceof Error ? err.message : String(err) },
        'standard handle resolution failed, trying PLC fallback',
      )
    }

    // Fallback: resolve via PLC directory (trusted endpoint, no SSRF risk)
    try {
      const plcUrl = cfg.identity.plcUrl
      const resolveUrl = `${plcUrl}/did-by-handle/${encodeURIComponent(handle)}`
      const resp = await fetchWithUserAgent(resolveUrl)
      if (resp.ok) {
        const did = await resp.text()
        if (did && did.startsWith('did:')) {
          logger?.info(
            { handle, did },
            'resolved handle via PLC directory fallback',
          )
          return did
        }
      }
    } catch (err) {
      logger?.debug(
        { handle, err: err instanceof Error ? err.message : String(err) },
        'PLC handle resolution fallback failed',
      )
    }

    return undefined
  }

  const keyPath = path.join(cfg.storage.dataDir, 'signing_key')
  let signingKey: crypto.Keypair

  if (await fileExists(keyPath)) {
    const keyBytes = await fs.readFile(keyPath)
    signingKey = await crypto.Secp256k1Keypair.import(keyBytes)
  } else {
    signingKey = await crypto.Secp256k1Keypair.create({ exportable: true })
    const exported = await (signingKey as crypto.ExportableKeypair).export()
    await fs.writeFile(keyPath, exported)
  }

  const signingDidKey = signingKey.did()

  const oauthClient = await createOAuthClient(
    {
      clientId:
        cfg.oauth.clientId ?? `${cfg.service.publicUrl}/client-metadata.json`,
      clientUri: cfg.service.publicUrl,
      redirectUri: `${cfg.service.publicUrl}/oauth/callback`,
      privateKeyPem: cfg.oauth.clientSecret,
      scope: OAUTH_SCOPE,
      clientName: cfg.oauth.clientName,
      logoUri: cfg.oauth.logoUri,
      tosUri: cfg.oauth.tosUri,
      policyUri: cfg.oauth.policyUri,
    },
    oauthStores,
    idResolver,
    fetchWithUserAgent,
  )

  let actorStore: ActorStore
  if (cfg.storage.backend === 'postgres') {
    if (!cfg.storage.postgresUrl) {
      throw new Error(
        'STRATOS_POSTGRES_URL is required when backend is postgres',
      )
    }
    actorStore = new PostgresActorStore({
      connectionString: cfg.storage.postgresUrl,
      blobstore,
      cborToRecord,
      logger,
      actorPoolSize: cfg.storage.pgActorPoolSize,
      adminPoolSize: cfg.storage.pgAdminPoolSize,
      blockCacheSize: cfg.storage.blockCacheSize,
    })
  } else {
    actorStore = new StratosActorStore({
      dataDir: path.join(cfg.storage.dataDir, 'actors'),
      blobstore,
      cborToRecord,
      logger,
    })
  }

  const enrollmentEvents: EnrollmentEventEmitter = new EventEmitter()

  const enrollmentService = new EnrollmentServiceImpl(
    enrollmentStore,
    async (did) => {
      await actorStore.create(did)
      // Initialize repo with an empty signed commit so it's valid from enrollment
      await actorStore.transact(did, async (store) => {
        const adapter = new StratosBlockStoreReader(store.repo)
        const unsigned = await buildCommit(adapter, null, { did, writes: [] })
        await signAndPersistCommit(store.repo, signingKey, unsigned)
      })
    },
    logger,
    enrollmentEvents,
    cfg.service.publicUrl,
  )

  // Resolves per-user boundaries from storage
  const boundaryResolver = new EnrollmentBoundaryResolver(enrollmentStore)

  // Initialize external allow list provider if configured
  let allowListProvider: ExternalAllowListProvider | undefined
  if (cfg.enrollment.allowListUrl) {
    const cache = cfg.enrollment.valkeyUrl
      ? new RedisCache(cfg.enrollment.valkeyUrl)
      : undefined
    allowListProvider = new ExternalAllowListProvider(
      cfg.enrollment.allowListUrl,
      cache,
      cfg.enrollment.allowListBootstrapName,
      logger,
    )
    await allowListProvider.start()
  }

  // No audience check: PDS tokens have aud=PDS DID, not Stratos's URL.
  // Security is ensured by DPoP binding, JWKS signature, and enrollment checks.
  const tokenVerifier = new PdsTokenVerifier({
    idResolver,
    fetch: fetchWithUserAgent,
    jwksCacheMaxAge: 10 * 60 * 1000,
    verifyCacheMaxAge: 5 * 60 * 1000,
    verifyCacheMaxSize: 10_000,
  })
  const dpopVerifier = new DpopVerifier({
    serviceDid: cfg.service.did,
    serviceEndpoint: cfg.service.publicUrl,
    tokenVerifier,
    enrollmentStore,
    allowListProvider,
  })

  const authVerifier = createAuthVerifiers(
    cfg.service.did,
    idResolver,
    oauthClient,
    enrollmentStore,
    cfg.admin?.password,
    dpopVerifier,
    allowListProvider,
    cfg.stratos.devMode === true,
    cfg.syncToken,
  )

  const serviceDid = cfg.service.did
  // Fragment added for record source fields (e.g., did:plc:abc#atproto_pns)
  const serviceDidWithFragment = getServiceDidWithFragment(cfg)

  const stubWriter = new StubWriterServiceImpl(async (did) => {
    try {
      const session = await oauthClient.restore(did)
      return new Agent(session) as unknown as PdsAgent
    } catch {
      return null
    }
  }, serviceDidWithFragment)

  const stubQueue = new BackgroundStubQueue(stubWriter, logger)

  const app = express()
  // Note: express.json() is applied in index.ts with exclusion for /xrpc/ routes

  // Load Stratos lexicons from the lexicons directory
  const stratosLexicons = loadStratosLexicons()
  const allLexicons = [...atprotoSchemas, ...stratosLexicons]

  const xrpcServer = new XrpcServer(allLexicons, {
    errorParser: (err) => {
      console.error(
        '[xrpc] error caught:',
        err instanceof Error ? err.message : String(err),
      )
      if (err instanceof Error && err.stack) {
        console.error('[xrpc] error stack:', err.stack)
      }
      return XRPCError.fromError(err)
    },
  })

  const createAttestation = async (
    did: string,
    boundaries: string[],
    userDidKey: string,
  ): Promise<{ sig: Uint8Array; signingKey: string }> => {
    const payload = createAttestationPayload(did, boundaries, userDidKey)
    const sig = await signingKey.sign(payload)
    return { sig, signingKey: signingDidKey }
  }

  return {
    cfg,
    version: VERSION,
    db,
    actorStore,
    enrollmentStore,
    enrollmentService,
    boundaryResolver,
    stubWriter,
    stubQueue,
    authVerifier,
    idResolver,
    oauthClient,
    signingKey,
    signingDidKey,
    serviceDid,
    allowListProvider,
    xrpcServer,
    app,
    logger,
    createAttestation,
    dpopVerifier,
    enrollmentEvents,
    destroy: async () => {
      await stubQueue.drain()
      await actorStore.close?.()
      await destroyBackend()
    },
  }
}

/**
 * Cleanup application context
 */
export async function destroyAppContext(ctx: AppContext): Promise<void> {
  if (ctx.allowListProvider) {
    await ctx.allowListProvider.stop()
  }
  await ctx.destroy()
}
