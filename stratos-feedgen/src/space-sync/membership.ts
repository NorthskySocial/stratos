import type { Purger } from '../purge/index.js'
import type { FeedgenStore, SpaceMemberSnapshot } from '../db/index.js'
import { DEFAULT_SPACE_MEMBERSHIP_PAGE_LIMIT } from '../config.js'
import {
  SpaceMutationFence,
  type SpaceAuthorizationLease,
} from '../mutation-fence.js'
import type { SpaceCredentialManager } from '../space-credential/index.js'
import type { UpstreamStratosClient } from '../upstream/index.js'
import {
  MembershipCursorStalledError,
  MembershipPageLimitError,
} from './errors.js'

/**
 * Page ceiling for one boundary's enumeration. At the default 100 rows per
 * page, this covers 10,000 members before an enumeration is abandoned as
 * failed — far more than a legitimate space, and a backstop against a host
 * that never terminates pagination.
 */
const DEFAULT_MAX_ENUMERATION_PAGES = 100

/** A `pds`-custody member ready to poll: their space, boundary, DID, and repo host. */
export interface PollTarget {
  readonly spaceUri: string
  readonly boundary: string
  readonly did: string
  readonly host: string
  /** Internal membership lease; rotated into a per-run lease before polling. */
  readonly lease?: SpaceAuthorizationLease
}

/** A member purged this pass because they left one boundary, or every boundary tracked here. */
export interface RemovedMember {
  readonly did: string
  /**
   * `'boundary'`: still a member of another tracked boundary, purged via
   * `purgeSpaceDeparture`. `'actor'`: gone from every tracked boundary,
   * purged via `purgeSpaceActor`.
   */
  readonly scope: 'actor' | 'boundary'
}

export interface BoundaryPassSuccess {
  readonly boundary: string
  readonly ok: true
  /** Current `pds`-custody poll targets for this boundary, after this pass. */
  readonly polls: PollTarget[]
  /** `pds`-custody members seen this pass with no resolvable host — not polled. */
  readonly skippedNoHost: number
  /** Members purged this pass because they left this boundary (or the actor entirely). */
  readonly removed: RemovedMember[]
}

export interface BoundaryPassFailure {
  readonly boundary: string
  readonly ok: false
  /** Last pass's poll targets, unchanged. A failed enumeration purges nothing. */
  readonly polls: PollTarget[]
  readonly error: unknown
}

export type BoundaryPassOutcome = BoundaryPassSuccess | BoundaryPassFailure

export interface MembershipPassLogEvent {
  successfulBoundaries: number
  failedBoundaries: number
  pollTargets: number
  skippedNoHost: number
  removed: number
}

export interface MembershipTrackerDeps {
  client: Pick<UpstreamStratosClient, 'listSpaceRepos'>
  credentialManager: Pick<SpaceCredentialManager, 'getCredential'>
  purger: Pick<Purger, 'purgeSpaceActor' | 'purgeSpaceDeparture'>
  snapshotStore?: Pick<FeedgenStore, 'listSpaceMembers' | 'replaceSpaceMembers'>
  /** Must be the same instance used by the production purger and syncer. */
  mutationFence?: Pick<
    SpaceMutationFence,
    'captureRevocationEpoch' | 'authorizeSnapshot'
  >
  /** Structured whole-pass summary sink. Defaults to `console.log(JSON.stringify(...))`. */
  log?: (event: MembershipPassLogEvent) => void
  /** Called when a boundary's enumeration fails this pass. Defaults to `console.error`. */
  onError?: (boundary: string, err: unknown) => void
  /** Page ceiling for one boundary's enumeration. Default 100. */
  maxEnumerationPages?: number
  /** Rows requested per enumeration page. Default 100. */
  pageLimit?: number
}

interface BoundaryEnumeration {
  boundary: string
  polls: PollTarget[]
  skippedNoHost: string[]
  spaceUri: string
  revocationEpoch: number
  /**
   * Every DID seen in a completed listing, regardless of custody or host.
   * The presence signal for departure detection — `polls` alone only covers
   * the subset that is also pollable, and a DID can be absent from `polls`
   * for reasons (hostless, custody flip) that are not departure.
   */
  members: Map<string, SpaceMemberSnapshot>
}

interface BoundaryMembershipState {
  polls: PollTarget[]
  members: Map<string, SpaceMemberSnapshot>
}

interface CompletedBoundary {
  enumeration: BoundaryEnumeration
  membership: BoundaryMembershipState
  outcome: BoundaryPassSuccess
}

interface DepartedMember {
  outcome: BoundaryPassSuccess
  did: string
  spaceUri: string
}

interface PreparedMembershipPass {
  outcomes: BoundaryPassOutcome[]
  completed: CompletedBoundary[]
  left: DepartedMember[]
  nextMembership: Map<string, BoundaryMembershipState>
}

/**
 * Tracks `pds`-custody space membership across passes and produces poll
 * targets for the space poller (WP4).
 *
 * Membership decides whose repo the syncer reads — it is the only
 * write-side control that exists. This tracker only ever produces a poll
 * target for a DID that came from a `listSpaceRepos` page; it never
 * discovers writers.
 *
 * Member-presence snapshots are persisted so a restart cannot forget a
 * departure baseline. Poll targets and authorization leases remain
 * in-process: a boundary whose enumeration fails mid-pagination keeps its
 * previous live targets and purges nothing this pass — absence means
 * something only once a complete listing confirms it.
 */
export class MembershipTracker {
  private readonly client: Pick<UpstreamStratosClient, 'listSpaceRepos'>
  private readonly credentialManager: Pick<
    SpaceCredentialManager,
    'getCredential'
  >
  private readonly purger: Pick<
    Purger,
    'purgeSpaceActor' | 'purgeSpaceDeparture'
  >
  private readonly mutationFence: Pick<
    SpaceMutationFence,
    'captureRevocationEpoch' | 'authorizeSnapshot'
  >
  private readonly snapshotStore: Pick<
    FeedgenStore,
    'listSpaceMembers' | 'replaceSpaceMembers'
  >
  private readonly log: (event: MembershipPassLogEvent) => void
  private readonly onError: (boundary: string, err: unknown) => void
  private readonly maxEnumerationPages: number
  private readonly pageLimit: number
  private readonly lastMembership = new Map<string, BoundaryMembershipState>()

  constructor(deps: MembershipTrackerDeps) {
    this.client = deps.client
    this.credentialManager = deps.credentialManager
    this.purger = deps.purger
    this.mutationFence = deps.mutationFence ?? new SpaceMutationFence()
    this.snapshotStore = deps.snapshotStore ?? new InMemorySnapshotStore()
    this.log = deps.log ?? defaultLog
    this.onError = deps.onError ?? defaultOnError
    this.maxEnumerationPages =
      deps.maxEnumerationPages ?? DEFAULT_MAX_ENUMERATION_PAGES
    this.pageLimit = deps.pageLimit ?? DEFAULT_SPACE_MEMBERSHIP_PAGE_LIMIT
  }

  /**
   * Run one membership pass over `boundaries`. Each boundary is enumerated
   * independently (`Promise.allSettled`) so one failing boundary — an
   * unreachable mirror, a credential mint failure, a mid-pagination error —
   * never blocks the others.
   *
   * Purges apply only after every boundary's outcome is known, so a member
   * who left one completed boundary but still holds another tracked
   * boundary is boundary-shrunk, not fully purged.
   */
  async runPass(boundaries: Iterable<string>): Promise<BoundaryPassOutcome[]> {
    const boundaryList = [...boundaries]
    await this.loadPersistedMembership(boundaryList)
    const settled = await Promise.allSettled(
      boundaryList.map((boundary) => this.enumerateBoundary(boundary)),
    )
    const everyBoundaryCompletedThisPass = settled.every(
      (result) => result.status === 'fulfilled',
    )
    const prepared = this.preparePass(boundaryList, settled)
    await this.purgeHostChanges(prepared.completed)
    const deferred = await this.purgeDepartures(
      prepared.left,
      prepared.nextMembership,
      everyBoundaryCompletedThisPass,
    )
    await this.publishCompleted(prepared.completed, deferred)
    this.reportPass(prepared.outcomes)
    return prepared.outcomes
  }

  private preparePass(
    boundaryList: readonly string[],
    settled: readonly PromiseSettledResult<BoundaryEnumeration>[],
  ): PreparedMembershipPass {
    const outcomes = new Array<BoundaryPassOutcome>(boundaryList.length)
    const completed: CompletedBoundary[] = []
    const left: DepartedMember[] = []
    const nextMembership = new Map(this.lastMembership)
    settled.forEach((result, index) => {
      const boundary = boundaryList[index]
      const previous = this.lastMembership.get(boundary)
      if (result.status === 'rejected') {
        outcomes[index] = {
          boundary,
          ok: false,
          polls: previous?.polls ?? [],
          error: result.reason,
        }
        return
      }
      const enumeration = {
        ...result.value,
        members: preserveHostAcrossHostlessSnapshot(
          result.value.members,
          previous?.members,
        ),
      }
      const membership = { polls: [], members: enumeration.members }
      nextMembership.set(boundary, membership)
      const outcome: BoundaryPassSuccess = {
        boundary,
        ok: true,
        polls: membership.polls,
        skippedNoHost: enumeration.skippedNoHost.length,
        removed: [],
      }
      outcomes[index] = outcome
      completed.push({ enumeration, membership, outcome })
      for (const did of previous?.members.keys() ?? []) {
        if (!enumeration.members.has(did)) {
          left.push({ outcome, did, spaceUri: enumeration.spaceUri })
        }
      }
    })
    return { outcomes, completed, left, nextMembership }
  }

  private async purgeHostChanges(
    completed: readonly CompletedBoundary[],
  ): Promise<void> {
    for (const { enumeration } of completed) {
      const previous = this.lastMembership.get(enumeration.boundary)
      for (const [did, prior] of previous?.members ?? []) {
        const current = enumeration.members.get(did)
        if (current && pdsStateChanged(prior, current)) {
          await this.purger.purgeSpaceDeparture(
            did,
            enumeration.boundary,
            enumeration.spaceUri,
          )
        }
      }
    }
  }

  private async purgeDepartures(
    left: readonly DepartedMember[],
    nextMembership: ReadonlyMap<string, BoundaryMembershipState>,
    everyBoundaryCompleted: boolean,
  ): Promise<ReadonlySet<string>> {
    const deferred = everyBoundaryCompleted
      ? new Set<string>()
      : new Set(left.map(({ outcome }) => outcome.boundary))
    const purgedActor = new Set<string>()
    for (const { outcome, did, spaceUri } of left) {
      const stillMember = [...nextMembership.values()].some((state) =>
        state.members.has(did),
      )
      if (stillMember || !everyBoundaryCompleted) {
        await this.purger.purgeSpaceDeparture(did, outcome.boundary, spaceUri)
        outcome.removed.push({ did, scope: 'boundary' })
      } else {
        outcome.removed.push({ did, scope: 'actor' })
        if (!purgedActor.has(did)) {
          purgedActor.add(did)
          await this.purger.purgeSpaceActor(did)
        }
      }
    }
    return deferred
  }

  private async publishCompleted(
    completed: readonly CompletedBoundary[],
    deferred: ReadonlySet<string>,
  ): Promise<void> {
    for (const { enumeration, membership, outcome } of completed) {
      const leases = await this.mutationFence.authorizeSnapshot({
        boundary: enumeration.boundary,
        spaceUri: enumeration.spaceUri,
        dids: enumeration.polls.map((poll) => poll.did),
        revocationEpoch: enumeration.revocationEpoch,
      })
      for (const poll of enumeration.polls) {
        const lease = leases.get(poll.did)
        if (lease) outcome.polls.push({ ...poll, lease })
      }
      const remembered = this.rememberedMembership(
        enumeration.boundary,
        membership,
        deferred,
      )
      await this.snapshotStore.replaceSpaceMembers(enumeration.boundary, [
        ...remembered.members.values(),
      ])
      this.lastMembership.set(enumeration.boundary, remembered)
    }
  }

  private rememberedMembership(
    boundary: string,
    current: BoundaryMembershipState,
    deferred: ReadonlySet<string>,
  ): BoundaryMembershipState {
    if (!deferred.has(boundary)) return current
    const previous = this.lastMembership.get(boundary)
    return {
      polls: current.polls,
      members: new Map([...(previous?.members ?? []), ...current.members]),
    }
  }

  private reportPass(outcomes: readonly BoundaryPassOutcome[]): void {
    for (const outcome of outcomes) {
      if (!outcome.ok) this.onError(outcome.boundary, outcome.error)
    }
    const successful = outcomes.filter(
      (outcome): outcome is BoundaryPassSuccess => outcome.ok,
    )
    this.log({
      successfulBoundaries: successful.length,
      failedBoundaries: outcomes.length - successful.length,
      pollTargets: sumBy(successful, (outcome) => outcome.polls.length),
      skippedNoHost: sumBy(successful, (outcome) => outcome.skippedNoHost),
      removed: sumBy(successful, (outcome) => outcome.removed.length),
    })
  }

  private async enumerateBoundary(
    boundary: string,
  ): Promise<BoundaryEnumeration> {
    const revocationEpoch = this.mutationFence.captureRevocationEpoch()
    const credential = await this.credentialManager.getCredential(boundary)
    const members = new Map<string, SpaceMemberSnapshot>()
    let cursor: string | undefined
    let pages = 0
    do {
      pages += 1
      if (pages > this.maxEnumerationPages) {
        throw new MembershipPageLimitError(boundary, this.maxEnumerationPages)
      }
      const page = await this.client.listSpaceRepos(
        { space: credential.spaceUri, cursor, limit: this.pageLimit },
        credential,
      )
      for (const row of page.repos) {
        members.set(row.did, {
          did: row.did,
          custody: row.custody,
          ...(row.host ? { host: row.host } : {}),
        })
      }
      // A host that returns the same cursor forever would otherwise spin
      // this loop indefinitely without ever tripping the page ceiling above.
      if (page.cursor !== undefined && page.cursor === cursor) {
        throw new MembershipCursorStalledError(boundary, page.cursor)
      }
      cursor = page.cursor
    } while (cursor !== undefined)

    const pdsMembers = [...members.values()].filter(
      (member) => member.custody === 'pds',
    )
    return {
      boundary,
      polls: pdsMembers.flatMap((member) =>
        member.host
          ? [
              {
                spaceUri: credential.spaceUri,
                boundary,
                did: member.did,
                host: member.host,
              },
            ]
          : [],
      ),
      skippedNoHost: pdsMembers
        .filter((member) => !member.host)
        .map((member) => member.did),
      spaceUri: credential.spaceUri,
      revocationEpoch,
      members,
    }
  }

  private async loadPersistedMembership(
    boundaries: readonly string[],
  ): Promise<void> {
    await Promise.all(
      boundaries.map(async (boundary) => {
        if (this.lastMembership.has(boundary)) return
        const members = await this.snapshotStore.listSpaceMembers(boundary)
        this.lastMembership.set(boundary, {
          polls: [],
          members: new Map(members.map((member) => [member.did, member])),
        })
      }),
    )
  }
}

class InMemorySnapshotStore {
  private readonly members = new Map<string, SpaceMemberSnapshot[]>()

  async listSpaceMembers(boundary: string): Promise<SpaceMemberSnapshot[]> {
    return this.members.get(boundary) ?? []
  }

  async replaceSpaceMembers(
    boundary: string,
    members: SpaceMemberSnapshot[],
  ): Promise<void> {
    this.members.set(boundary, members)
  }
}

function preserveHostAcrossHostlessSnapshot(
  current: Map<string, SpaceMemberSnapshot>,
  previous?: Map<string, SpaceMemberSnapshot>,
): Map<string, SpaceMemberSnapshot> {
  const preserved = new Map(current)
  for (const [did, member] of current) {
    const prior = previous?.get(did)
    if (
      member.custody === 'pds' &&
      !member.host &&
      prior?.custody === 'pds' &&
      prior.host
    ) {
      preserved.set(did, { ...member, host: prior.host })
    }
  }
  return preserved
}

function pdsStateChanged(
  previous: SpaceMemberSnapshot,
  current: SpaceMemberSnapshot,
): boolean {
  if (previous.custody !== 'pds') return false
  if (current.custody !== 'pds') return true
  return Boolean(
    previous.host && current.host && previous.host !== current.host,
  )
}

function sumBy<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0)
}

function defaultLog(event: MembershipPassLogEvent): void {
  console.log(
    JSON.stringify({ msg: 'feedgen.space-membership-pass', ...event }),
  )
}

function defaultOnError(boundary: string, err: unknown): void {
  console.error(`space membership pass failed for boundary ${boundary}:`, err)
}
