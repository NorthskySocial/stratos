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
  type Logger,
  type StubWriterService,
} from '@northskysocial/stratos-core'
import type { ActorStore } from './actor-store-types.js'
import {
  BackgroundStubQueue,
  ExternalAllowListProvider,
} from './features/index.js'
import { type StratosServiceConfig } from './config.js'
import { type EnrollmentStore } from './oauth/routes.js'
import { type ServiceDb } from './db/index.js'
import { AuthVerifiers } from './auth/verifiers.js'
import { DpopVerifier } from './auth/index.js'
import { WriteRateLimiter } from './rate-limiter.js'
import { RepoWriteLocks } from './repo-write-lock.js'

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
  enrollmentStore: EnrollmentStore
  writeRateLimiter: WriteRateLimiter
  rateLimits: WriteRateLimiter // Added for compatibility
  repoWriteLocks: RepoWriteLocks
}

/**
 * Application context for Stratos service
 */
export interface AppContext extends IdentityContext, StorageContext {
  cfg: StratosServiceConfig
  version: string
  enrollmentService: EnrollmentService
  profileRecordWriter: import('@northskysocial/stratos-core').ProfileRecordWriter
  boundaryResolver: BoundaryResolver
  stubWriter: StubWriterService
  stubQueue: BackgroundStubQueue
  authVerifier: AuthVerifiers
  allowListProvider?: ExternalAllowListProvider
  xrpcServer: XrpcServer
  app: express.Application
  logger?: Logger
  dpopVerifier: DpopVerifier
  enrollmentEvents: EnrollmentEventEmitter
  sequenceEvents: SequenceEventEmitter
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
