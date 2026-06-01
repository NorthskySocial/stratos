import { type IdResolver } from '@atproto/identity'
import { type NodeOAuthClient } from '@atproto/oauth-client-node'
import {
  type EnrollmentStoreReader,
  type Logger,
} from '@northskysocial/stratos-core'
import {
  type EnrollmentContext,
  type EnrollmentEventEmitter,
} from '../../context-types.js'
import { type StratosServiceConfig } from '../../config.js'
import { type EnrollmentStore } from '../../oauth/routes.js'
import { EnrollmentServiceImpl, EnrollmentValidatorImpl } from './adapter.js'
import { ProfileRecordWriterImpl } from './internal/profile-record-writer.js'
import { ExternalAllowListProvider } from './internal/allow-list.js'
import { type ActorStore } from '../../actor-store-types.js'
import { RedisCache } from '../../infra/storage/redis-cache.js'

/**
 * Initialize the enrollment context
 * @param cfg - Stratos service configuration
 * @param enrollmentStore - Enrollment store reader and writer
 * @param actorStore - Actor store reader and writer
 * @param enrollmentEvents - Enrollment event emitter
 * @param idResolver - Identity resolver
 * @param oauthClient - OAuth client
 * @param logger - Optional logger
 * @returns Initialized enrollment context
 */
export async function initEnrollment(
  cfg: StratosServiceConfig,
  enrollmentStore: EnrollmentStore & EnrollmentStoreReader,
  actorStore: ActorStore,
  enrollmentEvents: EnrollmentEventEmitter,
  idResolver: IdResolver,
  oauthClient: NodeOAuthClient,
  logger?: Logger,
): Promise<
  EnrollmentContext & { allowListProvider?: ExternalAllowListProvider }
> {
  const allowListProvider = await initAllowListProvider(cfg, logger)

  const enrollmentService = new EnrollmentServiceImpl(
    enrollmentStore,
    (did) => actorStore.create(did),
    (did) => actorStore.destroy(did),
    logger,
    enrollmentEvents,
    cfg.service.publicUrl,
  )

  const enrollmentValidator = new EnrollmentValidatorImpl(
    cfg.enrollment,
    idResolver,
    allowListProvider,
  )

  const profileRecordWriter = new ProfileRecordWriterImpl(async (did) => {
    try {
      const session = await oauthClient.restore(did)
      return { handler: session.fetchHandler.bind(session) }
    } catch {
      return null
    }
  }, logger)

  return {
    enrollmentService,
    enrollmentStore,
    enrollmentValidator,
    profileRecordWriter,
    allowListProvider,
    enrollmentEvents,
  }
}

/**
 * Initialize the allow list provider if configured
 * @param cfg - Stratos service configuration
 * @param logger - Optional logger
 * @returns Initialized allow list provider or undefined if not configured
 */
async function initAllowListProvider(
  cfg: StratosServiceConfig,
  logger?: Logger,
): Promise<ExternalAllowListProvider | undefined> {
  if (!cfg.enrollment.allowListUrl) return undefined

  const cache = cfg.enrollment.valkeyUrl
    ? new RedisCache(cfg.enrollment.valkeyUrl)
    : undefined

  const provider = new ExternalAllowListProvider(
    cfg.enrollment.allowListUrl,
    cache,
    cfg.enrollment.allowListBootstrapName,
    logger,
  )

  await provider.start()
  return provider
}
