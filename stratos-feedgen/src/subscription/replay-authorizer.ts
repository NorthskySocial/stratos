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
  /** Locally maintained enrollment snapshots. */
  store: Pick<FeedgenStore, 'getEnrolledActor'>
  /**
   * Deliberately the upstream client rather than EnrollmentManager: a
   * disagreement with the local snapshot must bypass its TTL cache.
   */
  client: Pick<UpstreamStratosClient, 'resolveEnrollments'>
  /** Boundaries this feed generator is configured to serve. */
  configuredBoundaries: Iterable<string>
}

/**
 * Authorizes records replayed from an actor subscription against the actor's
 * current enrollment. The first admission for each actor resolves authority
 * directly, so an unchanged on-disk snapshot cannot re-authorize old data.
 * Later admissions use that answer until the local snapshot changes.
 */
export class CurrentMembershipReplayAuthorizer implements ReplayAuthorizer {
  private readonly store: Pick<FeedgenStore, 'getEnrolledActor'>
  private readonly client: Pick<UpstreamStratosClient, 'resolveEnrollments'>
  private readonly configuredBoundaries: ReadonlySet<string>
  private readonly authorityByDid = new Map<string, KnownAuthority>()

  constructor(opts: CurrentMembershipReplayAuthorizerOptions) {
    this.store = opts.store
    this.client = opts.client
    this.configuredBoundaries = new Set(opts.configuredBoundaries)
  }

  async authorize(
    did: string,
    recordBoundaries: readonly string[],
  ): Promise<string[]> {
    const requested = configuredRecordBoundaries(
      recordBoundaries,
      this.configuredBoundaries,
    )
    if (requested.length === 0) return []

    const enrolledActor = await this.store.getEnrolledActor(did)
    const snapshot: LocalMembershipSnapshot = {
      present: enrolledActor !== null,
      boundaries: configuredRecordBoundaries(
        enrolledActor?.boundaries ?? [],
        this.configuredBoundaries,
      ),
    }
    const authority = await this.getCurrentAuthority(did, snapshot)
    return requested.filter((boundary) => authority.boundaries.has(boundary))
  }

  private async getCurrentAuthority(
    did: string,
    snapshot: LocalMembershipSnapshot,
  ): Promise<KnownAuthority> {
    const known = this.authorityByDid.get(did)
    if (known) {
      // Keep a direct answer when the persisted snapshot is stale. A later
      // snapshot is meaningful only if it differs from both the state we
      // originally checked and the authority result we retained.
      if (sameSnapshot(snapshot, known.snapshot)) {
        return known
      }
      if (snapshotConfirmsAuthority(snapshot, known)) {
        known.snapshot = snapshot
        return known
      }
    }

    const resolved = await this.client.resolveEnrollments(did)
    assertValidResolution(did, resolved)
    const authority: KnownAuthority = {
      snapshot,
      enrolled: resolved.enrolled,
      boundaries: new Set(
        resolved.enrolled
          ? configuredRecordBoundaries(
              resolved.boundaries,
              this.configuredBoundaries,
            )
          : [],
      ),
    }
    this.authorityByDid.set(did, authority)
    return authority
  }
}

interface KnownAuthority {
  /** Local snapshot in effect when this direct authority answer was obtained. */
  snapshot: LocalMembershipSnapshot
  /** Whether the direct authority result says the actor remains enrolled. */
  enrolled: boolean
  /** Authoritative current configured-boundary membership. */
  boundaries: ReadonlySet<string>
}

interface LocalMembershipSnapshot {
  /** Absence is different from an enrolled actor with no configured boundaries. */
  present: boolean
  boundaries: string[]
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

function sameBoundaries(
  left: Iterable<string>,
  right: Iterable<string>,
): boolean {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  if (leftSet.size !== rightSet.size) return false
  return [...leftSet].every((boundary) => rightSet.has(boundary))
}

function sameSnapshot(
  left: LocalMembershipSnapshot,
  right: LocalMembershipSnapshot,
): boolean {
  return (
    left.present === right.present &&
    sameBoundaries(left.boundaries, right.boundaries)
  )
}

function snapshotConfirmsAuthority(
  snapshot: LocalMembershipSnapshot,
  authority: KnownAuthority,
): boolean {
  return (
    snapshot.present === authority.enrolled &&
    sameBoundaries(snapshot.boundaries, authority.boundaries)
  )
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
