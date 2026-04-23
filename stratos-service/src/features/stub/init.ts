import { type NodeOAuthClient } from '@atproto/oauth-client-node'
import { type Logger } from '@northskysocial/stratos-core'
import {
  type RepoContext,
  type SequenceEventEmitter,
} from '../../context-types.js'
import { type StratosServiceConfig } from '../../config.js'
import { type ActorStore } from '../../actor-store-types.js'
import { WriteRateLimiter } from '../../shared/rate-limiter.js'
import { RepoWriteLocks } from '../../shared/repo-write-lock.js'
import { type PdsAgent, StubWriterServiceImpl } from './adapter.js'
import { BackgroundStubQueue } from './internal/background-queue.js'
import { Agent } from '@atproto/api'

/**
 * Initialize the repo context
 * @param cfg - Stratos service configuration
 * @param actorStore - Actor store
 * @param sequenceEvents - Sequence event emitter
 * @param oauthClient - OAuth client
 * @param serviceDidWithFragment - Service DID with fragment
 * @param logger - Optional logger
 * @returns Initialized repo context
 */
export function initRepo(
  cfg: StratosServiceConfig,
  actorStore: ActorStore,
  sequenceEvents: SequenceEventEmitter,
  oauthClient: NodeOAuthClient,
  serviceDidWithFragment: string,
  logger?: Logger,
): RepoContext {
  const writeRateLimiter = new WriteRateLimiter({
    maxWrites: cfg.stratos.writeRateLimit.maxWrites,
    windowMs: cfg.stratos.writeRateLimit.windowMs,
    cooldownMs: cfg.stratos.writeRateLimit.cooldownMs,
    cooldownJitterMs: cfg.stratos.writeRateLimit.cooldownJitterMs,
  })

  const repoWriteLocks = new RepoWriteLocks()

  const stubWriter = new StubWriterServiceImpl(async (did) => {
    try {
      const session = await oauthClient.restore(did)
      return { api: new Agent(session) as unknown as PdsAgent['api'] }
    } catch (err) {
      logger?.error({ err }, 'Failed to restore OAuth session')
      return null
    }
  }, serviceDidWithFragment)

  const stubQueue = new BackgroundStubQueue(stubWriter, logger)

  return {
    actorStore,
    repoWriteLocks,
    writeRateLimiter,
    stubWriter,
    stubQueue,
    sequenceEvents,
  }
}
