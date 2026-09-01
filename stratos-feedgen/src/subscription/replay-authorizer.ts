import { StratosError } from '@northskysocial/stratos-core'
import type { FeedgenStore } from '../db/index.js'
import type {
  ResolveEnrollmentsResult,
  UpstreamStratosClient,
} from '../upstream/index.js'

/**
 * Decides which boundaries on a replayed actor-owned record can enter the
 * local feed index. Returning no boundaries is a safe denial, not a failure.
 */
export interface ReplayAuthorizer {
  authorize: (
    did: string,
    recordBoundaries: readonly string[],
  ) => Promise<string[]>
}

export interface CurrentMembershipReplayAuthorizerOptions {
  /**
   * Retained only for source compatibility with existing construction sites.
   * Replay authorization never reads persisted membership snapshots.
   */
  store?: Pick<FeedgenStore, 'getEnrolledActor'>
  /**
   * Deliberately the upstream client rather than EnrollmentManager: every
   * replay admission must bypass its TTL cache and resolve current authority.
   */
  client: Pick<UpstreamStratosClient, 'resolveEnrollments'>
  /** Boundaries this feed generator is configured to serve. */
  configuredBoundaries: Iterable<string>
}

/**
 * Authorizes records replayed from an actor subscription against the actor's
 * current enrollment. Every admission resolves authority directly, so a
 * retained local snapshot or prior response cannot re-authorize old data.
 */
export class CurrentMembershipReplayAuthorizer implements ReplayAuthorizer {
  private readonly client: Pick<UpstreamStratosClient, 'resolveEnrollments'>
  private readonly configuredBoundaries: ReadonlySet<string>

  constructor(opts: CurrentMembershipReplayAuthorizerOptions) {
    this.client = opts.client
    this.configuredBoundaries = new Set(opts.configuredBoundaries)
  }

  async authorize(
    did: string,
    recordBoundaries: readonly string[],
  ): Promise<string[]> {
    const resolved = await this.client.resolveEnrollments(did)
    assertValidResolution(did, resolved)
    if (!resolved.enrolled) return []

    const authority = new Set(
      configuredRecordBoundaries(
        resolved.boundaries,
        this.configuredBoundaries,
      ),
    )
    return configuredRecordBoundaries(
      recordBoundaries,
      this.configuredBoundaries,
    ).filter((boundary) => authority.has(boundary))
  }
}

function configuredRecordBoundaries(
  recordBoundaries: readonly string[],
  configuredBoundaries: ReadonlySet<string>,
): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const boundary of recordBoundaries) {
    if (!configuredBoundaries.has(boundary) || seen.has(boundary)) continue
    seen.add(boundary)
    result.push(boundary)
  }
  return result
}

function assertValidResolution(
  expectedDid: string,
  resolution: unknown,
): asserts resolution is ResolveEnrollmentsResult {
  const raw =
    resolution !== null && typeof resolution === 'object'
      ? (resolution as Record<string, unknown>)
      : undefined
  const boundaries = raw?.['boundaries']
  if (
    raw?.['did'] !== expectedDid ||
    typeof raw['enrolled'] !== 'boolean' ||
    !Array.isArray(boundaries) ||
    !boundaries.every((boundary: unknown) => typeof boundary === 'string')
  ) {
    throw new StratosError(
      `invalid enrollment resolution for ${expectedDid}`,
      'ACTOR_REPLAY_AUTHORITY_INVALID',
    )
  }
}
