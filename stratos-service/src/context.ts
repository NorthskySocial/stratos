import path from 'node:path'
import fs from 'node:fs/promises'
import express from 'express'
import { eq, gt, asc, sql } from 'drizzle-orm'
import * as crypto from '@atproto/crypto'
import { IdResolver } from '@atproto/identity'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { Server as XrpcServer } from '@atproto/xrpc-server'
import { fileExists } from '@atproto/common'

import {
  createStratosDb,
  migrateStratosDb,
  closeStratosDb,
  StratosDb,
  StratosRecordReader,
  StratosRecordTransactor,
  StratosSqlRepoReader,
  StratosSqlRepoTransactor,
  StratosBlobReader,
  StratosBlobTransactor,
  BlobStore,
  BlobStoreCreator,
  type Logger,
  EnrollmentService,
  BoundaryResolver,
  StubWriterService,
  type EnrollmentStoreReader,
  type StoredEnrollment,
  type ListEnrollmentsOptions,
} from '@anthropic/stratos-core'
import {
  EnrollmentServiceImpl,
  EnrollmentBoundaryResolver,
} from './features/index.js'
import { StubWriterServiceImpl } from './features/stub/index.js'

import { StratosServiceConfig, getServiceDidWithFragment } from './config.js'
import { createOAuthClient } from './oauth/client.js'
import { EnrollmentStore, EnrollmentRecord } from './oauth/routes.js'
import { 
  createServiceDb, 
  migrateServiceDb, 
  closeServiceDb, 
  ServiceDb,
  enrollment,
  enrollmentBoundary,
} from './db/index.js'
import { PdsTokenVerifier } from './auth/introspection-client.js'
import { DpopVerifier } from './auth/dpop-verifier.js'

/**
 * Per-actor Stratos store for reading
 */
export interface StratosActorReader {
  did: string
  record: StratosRecordReader
  repo: StratosSqlRepoReader
  blob: StratosBlobReader
}

/**
 * Per-actor Stratos store for writing
 */
export interface StratosActorTransactor {
  did: string
  db: StratosDb
  record: StratosRecordTransactor
  repo: StratosSqlRepoTransactor
  blob: StratosBlobTransactor
}

/**
 * Enrolled actor database schema
 */
interface EnrollmentTable {
  did: string
  enrolledAt: string
  pdsEndpoint: string | null
}

/**
 * Actor store manager for Stratos
 */
export class StratosActorStore {
  private dataDir: string
  private blobstore: BlobStoreCreator
  private logger?: Logger
  private cborToRecord: (content: Uint8Array) => Record<string, unknown>

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

  /**
   * Get file paths for an actor
   */
  private async getLocation(did: string) {
    const didHash = await crypto.sha256Hex(did)
    const directory = path.join(this.dataDir, didHash.slice(0, 2), did)
    const dbLocation = path.join(directory, 'stratos.sqlite')
    const blobLocation = path.join(directory, 'blobs')
    return { directory, dbLocation, blobLocation }
  }

  /**
   * Check if an actor database exists
   */
  async exists(did: string): Promise<boolean> {
    const { dbLocation } = await this.getLocation(did)
    return fileExists(dbLocation)
  }

  /**
   * Create a new actor database
   */
  async create(did: string): Promise<void> {
    const { directory, dbLocation } = await this.getLocation(did)
    await fs.mkdir(directory, { recursive: true })

    const db = createStratosDb(dbLocation)
    try {
      await migrateStratosDb(db)
    } finally {
      await closeStratosDb(db)
    }
  }

  /**
   * Delete an actor database
   */
  async destroy(did: string): Promise<void> {
    const { directory } = await this.getLocation(did)
    await fs.rm(directory, { recursive: true, force: true })
  }

  /**
   * Open a database for reading
   */
  async read<T>(
    did: string,
    fn: (store: StratosActorReader) => T | PromiseLike<T>,
  ): Promise<T> {
    const { dbLocation } = await this.getLocation(did)
    const db = createStratosDb(dbLocation)
    const blobStore = this.blobstore(did)

    try {
      const store: StratosActorReader = {
        did,
        record: new StratosRecordReader(db, this.cborToRecord, this.logger),
        repo: new StratosSqlRepoReader(db),
        blob: new StratosBlobReader(db, blobStore, this.logger),
      }
      return await fn(store)
    } finally {
      await closeStratosDb(db)
    }
  }

  /**
   * Open a database for writing within a transaction
   */
  async transact<T>(
    did: string,
    fn: (store: StratosActorTransactor) => T | PromiseLike<T>,
  ): Promise<T> {
    const { dbLocation } = await this.getLocation(did)
    const db = createStratosDb(dbLocation)
    const blobStore = this.blobstore(did)

    try {
      return await db.transaction(async (tx) => {
        const store: StratosActorTransactor = {
          did,
          db: tx as unknown as StratosDb,
          record: new StratosRecordTransactor(tx as any, this.cborToRecord, this.logger),
          repo: new StratosSqlRepoTransactor(tx as any),
          blob: new StratosBlobTransactor(tx as any, blobStore, this.logger),
        }
        return await fn(store)
      })
    } finally {
      await closeStratosDb(db)
    }
  }
}

/**
 * SQLite enrollment store implements both OAuth EnrollmentStore
 * and stratos-core EnrollmentStoreReader interfaces
 */
export class SqliteEnrollmentStore implements EnrollmentStore, EnrollmentStoreReader {
  constructor(private db: ServiceDb) {}

  async isEnrolled(did: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(enrollment)
      .where(eq(enrollment.did, did))
      .limit(1)

    return rows.length > 0
  }

  async enroll(record: EnrollmentRecord): Promise<void> {
    await this.db
      .insert(enrollment)
      .values({
        did: record.did,
        enrolledAt: record.enrolledAt,
        pdsEndpoint: record.pdsEndpoint ?? null,
      })
      .onConflictDoUpdate({
        target: enrollment.did,
        set: {
          enrolledAt: record.enrolledAt,
          pdsEndpoint: record.pdsEndpoint ?? null,
        },
      })

    if (record.boundaries && record.boundaries.length > 0) {
      await this.db
        .delete(enrollmentBoundary)
        .where(eq(enrollmentBoundary.did, record.did))

      await this.db.insert(enrollmentBoundary).values(
        record.boundaries.map((boundary) => ({ did: record.did, boundary })),
      )
    }
  }

  async unenroll(did: string): Promise<void> {
    await this.db
      .delete(enrollmentBoundary)
      .where(eq(enrollmentBoundary.did, did))

    await this.db
      .delete(enrollment)
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
    }
  }

  async listEnrollments(options?: ListEnrollmentsOptions): Promise<StoredEnrollment[]> {
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
  standard: (ctx: any) => Promise<{ credentials: { type: string; did: string } }>
  /** Service-to-service auth (inter-service JWT) */
  service: (ctx: any) => Promise<{ credentials: { type: string; did: string; iss: string } }>
  /** Optional user auth */
  optionalStandard: (ctx: any) => Promise<{ credentials: { type: string; did?: string } }>
  /** Admin auth (basic auth or bearer token with admin password) */
  admin: (ctx: any) => Promise<{ credentials: { type: string } }>
}

/**
 * Create auth verifiers for the application
 */
function createAuthVerifiers(
  serviceDid: string,
  idResolver: IdResolver,
  oauthClient: NodeOAuthClient | undefined,
  enrollmentStore: EnrollmentStore,
  adminPassword: string | undefined,
  dpopVerifier: import('./auth/dpop-verifier.js').DpopVerifier | undefined,
): AuthVerifiers {
  // Helper to validate DID has active session
  const validateSession = async (did: string): Promise<boolean> => {
    if (!oauthClient) {
      // If no OAuth client, fall back to enrollment check
      return enrollmentStore.isEnrolled(did)
    }
    try {
      // Try to restore session - if successful, user has valid session
      await oauthClient.restore(did, false)
      return true
    } catch {
      return false
    }
  }

  return {
    standard: async (ctx) => {
      const authHeader = ctx.req?.headers?.authorization
      if (!authHeader) {
        throw new Error('Authorization required')
      }

      // Try DPoP verification first
      if (authHeader.startsWith('DPoP ') && dpopVerifier) {
        try {
          const result = await dpopVerifier.verify(
            {
              method: ctx.req.method || 'GET',
              url: ctx.req.url || '/',
              headers: ctx.req.headers as Record<string, string | string[] | undefined>,
            },
            {
              setHeader: (name, value) => ctx.res?.setHeader(name, value),
            },
          )
          return {
            credentials: { type: 'user', did: result.did },
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'DPoP verification failed'
          throw new Error(message)
        }
      }

      // Fall back to session-based auth for Bearer tokens
      const [scheme, token] = authHeader.split(' ')
      if (!token) {
        throw new Error('Invalid authorization header format')
      }
      
      // For now, support DID in token position for session-based auth
      // In production, this would parse the JWT to extract the DID
      const did = token.startsWith('did:') ? token : null
      if (!did) {
        throw new Error('Invalid token format: expected DID or DPoP token')
      }

      // Verify user has valid session
      const hasSession = await validateSession(did)
      if (!hasSession) {
        throw new Error('No valid session for user')
      }

      return {
        credentials: { type: 'user', did },
      }
    },
    service: async (ctx) => {
      const authHeader = ctx.req?.headers?.authorization
      if (!authHeader) {
        throw new Error('Service authorization required')
      }
      // Service auth validates inter-service JWT
      const [, token] = authHeader.split(' ')
      if (!token) {
        throw new Error('Invalid authorization header format')
      }
      // In production, would verify JWT signature and extract iss/aud
      // For now, trust service tokens (should be signed JWTs from AppViews)
      return {
        credentials: { type: 'service', did: serviceDid, iss: token },
      }
    },
    optionalStandard: async (ctx) => {
      const authHeader = ctx.req?.headers?.authorization
      if (!authHeader) {
        return { credentials: { type: 'none' } }
      }

      // Try DPoP verification first
      if (authHeader.startsWith('DPoP ') && dpopVerifier) {
        try {
          const result = await dpopVerifier.verify(
            {
              method: ctx.req.method || 'GET',
              url: ctx.req.url || '/',
              headers: ctx.req.headers as Record<string, string | string[] | undefined>,
            },
            {
              setHeader: (name, value) => ctx.res?.setHeader(name, value),
            },
          )
          return {
            credentials: { type: 'user', did: result.did },
          }
        } catch {
          // DPoP verification failed, return unauthenticated
          return { credentials: { type: 'none' } }
        }
      }

      // Fall back to session-based auth
      const [, token] = authHeader.split(' ')
      if (!token || !token.startsWith('did:')) {
        return { credentials: { type: 'none' } }
      }
      
      // Verify user has valid session (optional, so don't throw on failure)
      const hasSession = await validateSession(token)
      if (!hasSession) {
        return { credentials: { type: 'none' } }
      }
      
      return {
        credentials: { type: 'user', did: token },
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
        if (user !== 'admin' || pass !== adminPassword) {
          throw new Error('Invalid admin credentials')
        }
      } else if (authHeader.startsWith('Bearer ')) {
        // Simple bearer token: just the password
        const token = authHeader.slice(7)
        if (token !== adminPassword) {
          throw new Error('Invalid admin token')
        }
      } else {
        throw new Error('Unsupported authorization type')
      }
      
      return {
        credentials: { type: 'admin' },
      }
    },
  }
}

/**
 * Application context for Stratos service
 */
export interface AppContext {
  cfg: StratosServiceConfig
  db: ServiceDb
  actorStore: StratosActorStore
  enrollmentStore: EnrollmentStore
  enrollmentService: EnrollmentService
  boundaryResolver: BoundaryResolver
  stubWriter: StubWriterService
  authVerifier: AuthVerifiers
  idResolver: IdResolver
  oauthClient?: NodeOAuthClient
  signingKey: crypto.Keypair
  serviceDid: string
  xrpcServer: XrpcServer
  app: express.Application
  logger?: Logger
}

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
 * Create application context
 */
export async function createAppContext(
  opts: AppContextOptions,
): Promise<AppContext> {
  const { cfg, blobstore, cborToRecord, logger } = opts

  const serviceDbPath = path.join(cfg.storage.dataDir, 'service.sqlite')
  await fs.mkdir(cfg.storage.dataDir, { recursive: true })

  const db = createServiceDb(serviceDbPath)

  await migrateServiceDb(db)

  const idResolver = new IdResolver({
    plcUrl: cfg.identity.plcUrl,
  })

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

  let oauthClient: NodeOAuthClient | undefined
  if (cfg.oauth) {
    oauthClient = await createOAuthClient(
      {
        clientId: cfg.oauth.clientId ?? cfg.service.publicUrl,
        clientUri: cfg.service.publicUrl,
        redirectUri: `${cfg.service.publicUrl}/oauth/callback`,
        privateKeyPem: cfg.oauth.clientSecret,
        scope: 'atproto transition:generic',
      },
      db,
      idResolver,
    )
  }

  const actorStore = new StratosActorStore({
    dataDir: path.join(cfg.storage.dataDir, 'actors'),
    blobstore,
    cborToRecord,
    logger,
  })

  const enrollmentStore = new SqliteEnrollmentStore(db)

  const enrollmentService = new EnrollmentServiceImpl(
    { db },
    async (did) => actorStore.create(did),
  )

  // Resolves per-user boundaries from storage
  const boundaryResolver = new EnrollmentBoundaryResolver(enrollmentStore)

  let dpopVerifier: DpopVerifier | undefined
  if (cfg.oauth && oauthClient) {
    const tokenVerifier = new PdsTokenVerifier({
      idResolver,
      audience: cfg.service.publicUrl,
    })
    dpopVerifier = new DpopVerifier({
      serviceDid: cfg.service.did,
      serviceEndpoint: cfg.service.publicUrl,
      tokenVerifier,
      enrollmentStore,
    })
  }

  const authVerifier = createAuthVerifiers(cfg.service.did, idResolver, oauthClient, enrollmentStore, cfg.admin?.password, dpopVerifier)

  const serviceDid = cfg.service.did
  // Fragment added for record source fields (e.g., did:plc:abc#atproto_pns)
  const serviceDidWithFragment = getServiceDidWithFragment(cfg)

  const stubWriter = new StubWriterServiceImpl(
    async (did) => {
      if (!oauthClient) {
        return null
      }
      try {
        const session = await oauthClient.restore(did)
        return session ? { api: session } as any : null
      } catch {
        return null
      }
    },
    serviceDidWithFragment,
  )

  const app = express()
  app.use(express.json())

  const xrpcServer = new XrpcServer()

  return {
    cfg,
    db,
    actorStore,
    enrollmentStore,
    enrollmentService,
    boundaryResolver,
    stubWriter,
    authVerifier,
    idResolver,
    oauthClient,
    signingKey,
    serviceDid,
    xrpcServer,
    app,
    logger,
  }
}

/**
 * Cleanup application context
 */
export async function destroyAppContext(ctx: AppContext): Promise<void> {
  await closeServiceDb(ctx.db)
}
