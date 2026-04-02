import { EventEmitter } from 'node:events'
import express from 'express'
import { IdResolver } from '@atproto/identity'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { Server as XrpcServer } from '@atproto/xrpc-server'
import * as crypto from '@atproto/crypto'
import {
  type BlobStoreCreator,
  type BoundaryResolver,
  type EnrollmentService,
  type EnrollmentStoreReader,
  type Logger,
  type StubWriterService,
  type LexiconProvider,
} from '@northskysocial/stratos-core'
import type { ActorStore } from './actor-store-types.js'
import { BackgroundStubQueue } from './features/stub/internal/background-queue.js'
import { ExternalAllowListProvider } from './features/enrollment/internal/allow-list.js'
import { type StratosServiceConfig } from './config.js'
import { type EnrollmentStore } from './oauth/routes.js'
import { type ServiceDb } from './db/index.js'
import { AuthVerifiers } from './infra/auth/verifiers.js'
import { DpopVerifier } from './infra/auth/index.js'
import { WriteRateLimiter } from './shared/rate-limiter.js'
import { RepoWriteLocks } from './shared/repo-write-lock.js'

/**
 * Identity context for Stratos service
 */
export interface IdentityContext {
  idResolver: IdResolver
  oauthClient: NodeOAuthClient
  signingKey: crypto.Keypair
  signingDidKey: string
  serviceDid: string
  getActorSigningKey(did: string): Promise<crypto.Keypair>
  createAttestation(
    did: string,
    boundaries: string[],
    userDidKey: string,
  ): Promise<{ sig: Uint8Array; signingKey: string }>
}

/**
 * Storage context for Stratos service
 */
export interface StorageContext {
  db?: ServiceDb
  actorStore: ActorStore
  enrollmentStore: EnrollmentStore & EnrollmentStoreReader
  writeRateLimiter: WriteRateLimiter
  rateLimits: WriteRateLimiter // Added for compatibility
  repoWriteLocks: RepoWriteLocks
  oauthStores: {
    sessionStore: import('./oauth/client.js').OAuthSessionStoreBackend
    stateStore: import('./oauth/client.js').OAuthStateStoreBackend
  }
}

/**
 * Enrollment context for Stratos service
 */
export interface EnrollmentContext {
  enrollmentService: EnrollmentService
  enrollmentStore: EnrollmentStore & EnrollmentStoreReader
  profileRecordWriter: import('@northskysocial/stratos-core').ProfileRecordWriter
  allowListProvider?: ExternalAllowListProvider
  enrollmentEvents: EnrollmentEventEmitter
}

/**
 * Hydration context for Stratos service
 */
export interface HydrationContext {
  boundaryResolver: BoundaryResolver
}

/**
 * Repository context for Stratos service
 */
export interface RepoContext {
  actorStore: ActorStore
  repoWriteLocks: RepoWriteLocks
  writeRateLimiter: WriteRateLimiter
  stubWriter: StubWriterService
  stubQueue: BackgroundStubQueue
  sequenceEvents: SequenceEventEmitter
}

/**
 * Application context for Stratos service
 */
export interface AppContext
  extends
    IdentityContext,
    StorageContext,
    EnrollmentContext,
    HydrationContext,
    RepoContext {
  cfg: StratosServiceConfig
  version: string
  authVerifier: AuthVerifiers
  xrpcServer: XrpcServer
  lexiconProvider: LexiconProvider
  app: express.Application
  logger?: Logger
  dpopVerifier: DpopVerifier
  oauthStores: {
    sessionStore: import('./oauth/client.js').OAuthSessionStoreBackend
    stateStore: import('./oauth/client.js').OAuthStateStoreBackend
  }
  destroy: () => Promise<void>

  checkHealth(): Promise<{
    status: 'ok' | 'error'
    components: {
      db: 'ok' | 'error'
      blobstore: 'ok' | 'error'
    }
  }>
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

export type SequenceEventEmitter = EventEmitter<{
  [did: string]: []
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
