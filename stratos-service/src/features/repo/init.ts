import {
  type RepoContext,
  type SequenceEventEmitter,
} from '../../context-types.js'
import { type MstContext } from '../mst/init.js'
import { type StratosServiceConfig } from '../../config.js'
import { type ActorStore } from '../../actor-store-types.js'
import { WriteRateLimiter } from '../../shared/rate-limiter.js'
import { RepoWriteLocks } from '../../shared/repo-write-lock.js'

/**
 * Initialize the repo context
 * @param cfg - Stratos service configuration
 * @param actorStore - Actor store
 * @param mstCtx - MST context
 * @param sequenceEvents - Sequence event emitter
 * @returns Initialized repo context
 */
export function initRepo(
  cfg: StratosServiceConfig,
  actorStore: ActorStore,
  mstCtx: MstContext,
  sequenceEvents: SequenceEventEmitter,
): RepoContext {
  const writeRateLimiter = new WriteRateLimiter({
    maxWrites: cfg.stratos.writeRateLimit.maxWrites,
    windowMs: cfg.stratos.writeRateLimit.windowMs,
    cooldownMs: cfg.stratos.writeRateLimit.cooldownMs,
    cooldownJitterMs: cfg.stratos.writeRateLimit.cooldownJitterMs,
  })

  const repoWriteLocks = new RepoWriteLocks()

  return {
    ...mstCtx,
    actorStore,
    repoWriteLocks,
    writeRateLimiter,
    rateLimits: writeRateLimiter,
    sequenceEvents,
  }
}
