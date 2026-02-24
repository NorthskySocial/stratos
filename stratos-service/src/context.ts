import path from 'node:path'
import fs from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { eq, gt, asc, sql } from 'drizzle-orm'
import * as crypto from '@atproto/crypto'
import { IdResolver } from '@atproto/identity'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { Server as XrpcServer, XRPCError } from '@atproto/xrpc-server'
import { schemas as atprotoSchemas, Agent } from '@atproto/api'
import type { LexiconDoc } from '@atproto/lexicon'
import { fileExists } from '@atproto/common'

import {
  createStratosDb,
  migrateStratosDb,
  closeStratosDb,
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
} from '@northskysocial/stratos-core'
import {
  EnrollmentServiceImpl,
  EnrollmentBoundaryResolver,
  PdsAgent,
} from './features/index.js'
import { StubWriterServiceImpl } from './features/index.js'

import {
  type StratosServiceConfig,
  getServiceDidWithFragment,
} from './config.js'
import { createOAuthClient, OAUTH_SCOPE } from './oauth/client.js'
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
  db: StratosDbOrTx
  record: StratosRecordTransactor
  repo: StratosSqlRepoTransactor
  blob: StratosBlobTransactor
}

/**
 * Enrolled actor database schema
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface EnrollmentTable {
  did: string
  enrolledAt: string
  pdsEndpoint: string | null
}

/**
 * Actor store manager for Stratos
 */
export class StratosActorStore {
  private readonly dataDir: string
  private readonly blobstore: BlobStoreCreator
  private readonly logger?: Logger
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
      await db._initialized
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
    await db._initialized
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
    await db._initialized
    const blobStore = this.blobstore(did)

    try {
      return await db.transaction(async (tx) => {
        const store: StratosActorTransactor = {
          did,
          db: tx as unknown as StratosDbOrTx,
          record: new StratosRecordTransactor(
            tx as unknown as StratosDbOrTx,
            this.cborToRecord,
            this.logger,
          ),
          repo: new StratosSqlRepoTransactor(tx as unknown as StratosDbOrTx),
          blob: new StratosBlobTransactor(
            tx as unknown as StratosDbOrTx,
            blobStore,
            this.logger,
          ),
        }
        return fn(store)
      })
    } finally {
      await closeStratosDb(db)
    }
  }

  /**
   * Get the blobstore for an actor (for operations outside of a transaction)
   */
  getBlobStore(did: string): BlobStore {
    return this.blobstore(did)
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

    await this.db.delete(enrollment).where(eq(enrollment.did, did))
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
}

/**
 * Create auth verifiers for the application
 */
function createAuthVerifiers(
  serviceDid: string,
  _idResolver: IdResolver,
  _oauthClient: NodeOAuthClient | undefined,
  enrollmentStore: EnrollmentStore,
  adminPassword: string | undefined,
  dpopVerifier: import('./auth/dpop-verifier.js').DpopVerifier | undefined,
  devMode: boolean,
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
          if (isEnrolled) {
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
        const message =
          err instanceof Error ? err.message : 'DPoP verification failed'
        throw new Error(message, { cause: err })
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

      if (devMode && authHeader.startsWith('Bearer ')) {
        const did = authHeader.slice(7).trim()
        if (did.startsWith('did:')) {
          const isEnrolled = await enrollmentStore.isEnrolled(did)
          if (isEnrolled) {
            return { credentials: { type: 'user', did } }
          }
        }
        return { credentials: { type: 'none' } }
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

  const serviceDbPath = path.join(cfg.storage.dataDir, 'service.sqlite')
  await fs.mkdir(cfg.storage.dataDir, { recursive: true })

  const db = createServiceDb(serviceDbPath)

  await migrateServiceDb(db)

  const idResolver = new IdResolver({
    plcUrl: cfg.identity.plcUrl,
  })

  const originalResolve = idResolver.handle.resolve.bind(idResolver.handle)
  idResolver.handle.resolve = async (handle: string) => {
    try {
      // 1. Try standard resolution first
      const result = await originalResolve(handle)
      if (result) return result
    } catch (err) {
      logger?.debug(
        { handle, err: err instanceof Error ? err.message : String(err) },
        'standard handle resolution failed, trying PDS fallback',
      )
    }

    // 2. Fallback: Try resolving via PDS API if standard resolution fails
    // This is useful for PDSs with dynamic handles that don't support .well-known/atproto-did on subdomains
    try {
      const domain = handle.split('.').slice(1).join('.')
      if (domain) {
        const pdsUrl = `https://${domain}`
        const resolveUrl = `${pdsUrl}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
        const resp = await fetch(resolveUrl)
        if (resp.ok) {
          const data = (await resp.json()) as unknown as { did?: string }
          if (data.did) {
            logger?.info(
              { handle, did: data.did, pdsUrl },
              'resolved handle via PDS API fallback',
            )
            return data.did
          }
        }
      }
    } catch (err) {
      logger?.debug(
        { handle, err: err instanceof Error ? err.message : String(err) },
        'PDS handle resolution fallback failed',
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

  let oauthClient: NodeOAuthClient | undefined
  if (cfg.oauth) {
    oauthClient = await createOAuthClient(
      {
        clientId:
          cfg.oauth.clientId ?? `${cfg.service.publicUrl}/client-metadata.json`,
        clientUri: cfg.service.publicUrl,
        redirectUri: `${cfg.service.publicUrl}/oauth/callback`,
        privateKeyPem: cfg.oauth.clientSecret,
        scope: OAUTH_SCOPE,
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

  const enrollmentService = new EnrollmentServiceImpl({ db }, async (did) =>
    actorStore.create(did),
  )

  // Resolves per-user boundaries from storage
  const boundaryResolver = new EnrollmentBoundaryResolver(enrollmentStore)

  let dpopVerifier: DpopVerifier | undefined
  if (cfg.oauth && oauthClient) {
    // No audience check: PDS tokens have aud=PDS DID, not Stratos's URL.
    // Security is ensured by DPoP binding, JWKS signature, and enrollment checks.
    const tokenVerifier = new PdsTokenVerifier({
      idResolver,
    })
    dpopVerifier = new DpopVerifier({
      serviceDid: cfg.service.did,
      serviceEndpoint: cfg.service.publicUrl,
      tokenVerifier,
      enrollmentStore,
    })
  }

  const authVerifier = createAuthVerifiers(
    cfg.service.did,
    idResolver,
    oauthClient,
    enrollmentStore,
    cfg.admin?.password,
    dpopVerifier,
    cfg.stratos.devMode === true,
  )

  const serviceDid = cfg.service.did
  // Fragment added for record source fields (e.g., did:plc:abc#atproto_pns)
  const serviceDidWithFragment = getServiceDidWithFragment(cfg)

  const stubWriter = new StubWriterServiceImpl(async (did) => {
    if (!oauthClient) {
      return null
    }
    try {
      const session = await oauthClient.restore(did)
      return new Agent(session) as unknown as PdsAgent
    } catch {
      return null
    }
  }, serviceDidWithFragment)

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
