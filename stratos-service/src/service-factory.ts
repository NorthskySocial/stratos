import {
  type BoundaryResolver,
  buildCommit,
  type EnrollmentService,
  type Logger,
} from '@northskysocial/stratos-core'
import {
  EnrollmentServiceImpl,
  MigratingBoundaryResolver,
  signAndPersistCommit,
  StratosBlockStoreReader,
} from './features/index.js'
import type { EnrollmentStore } from './oauth/routes.js'
import type { EnrollmentEventEmitter } from './context-types.js'
import type { ActorStore } from './actor-store-types.js'
import * as crypto from '@atproto/crypto'

export interface ServiceFactoryOptions {
  enrollmentStore: EnrollmentStore
  actorStore: ActorStore
  enrollmentEvents: EnrollmentEventEmitter
  serviceUrl: string
  signingKey: crypto.Keypair
  logger?: Logger
}

/**
 * Factory for creating and managing Stratos domain services
 */
export class ServiceFactory {
  constructor(private opts: ServiceFactoryOptions) {}

  /**
   * Creates an instance of EnrollmentService with the provided options.
   * Initializes the actor store with an empty signed commit for each new DID.
   *
   * @returns An instance of EnrollmentService
   */
  createEnrollmentService(): EnrollmentService {
    return new EnrollmentServiceImpl(
      this.opts.enrollmentStore,
      async (did: string) => {
        await this.opts.actorStore.create(did)
        // Initialize repo with an empty signed commit so it's valid from enrollment
        await this.opts.actorStore.transact(did, async (store) => {
          const adapter = new StratosBlockStoreReader(store.repo)
          const unsigned = await buildCommit(adapter, null, {
            did: did,
            writes: [],
          })
          await signAndPersistCommit(store.repo, this.opts.signingKey, unsigned)
        })
      },
      (did: string) => this.opts.actorStore.destroy(did),
      this.opts.logger,
      this.opts.enrollmentEvents,
      this.opts.serviceUrl,
    )
  }

  /**
   * Creates an instance of BoundaryResolver with the provided options.
   *
   * @returns An instance of BoundaryResolver
   */
  createBoundaryResolver(): BoundaryResolver {
    return new MigratingBoundaryResolver({
      enrollmentStore: this.opts.enrollmentStore,
      serviceDid: this.opts.serviceUrl, // In Stratos, service DID/URL are often used interchangeably for qualification
      logger: this.opts.logger,
    })
  }
}
