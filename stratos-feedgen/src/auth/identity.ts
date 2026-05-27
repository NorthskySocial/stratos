import { IdResolver } from '@atproto/identity'

import type { FeedgenConfig } from '../config.js'

/**
 * Construct an `IdResolver` configured for the feed generator. WP6 wires the
 * resulting instance into the request context shared by all handlers.
 */
export function createIdResolver(cfg: FeedgenConfig): IdResolver {
  return new IdResolver({ plcUrl: cfg.feedgenPlcUrl })
}
