import type { Purger } from '../purge/index.js'
import type { SpaceCredentialManager } from '../space-credential/index.js'
import type { UpstreamStratosClient } from '../upstream/index.js'
import {
  MembershipCursorStalledError,
  MembershipPageLimitError,
} from './errors.js'

/** Rows requested per `listSpaceRepos` page. The lexicon's own maximum. */
const PAGE_LIMIT = 1000
/**
 * Page ceiling for one boundary's enumeration. At `PAGE_LIMIT` rows a page,
 * this covers 100,000 members before an enumeration is abandoned as failed —
 * far more than a legitimate space, and a backstop against a host that never
 * terminates pagination.
 */
const DEFAULT_MAX_ENUMERATION_PAGES = 100

/** A `pds`-custody member ready to poll: their space, boundary, DID, and repo host. */
export interface PollTarget {
  readonly spaceUri: string
  readonly boundary: string
  readonly did: string
  readonly host: string
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
  /** Structured whole-pass summary sink. Defaults to `console.log(JSON.stringify(...))`. */
  log?: (event: MembershipPassLogEvent) => void
  /** Called when a boundary's enumeration fails this pass. Defaults to `console.error`. */
  onError?: (boundary: string, err: unknown) => void
  /** Page ceiling for one boundary's enumeration. Default 100. */
  maxEnumerationPages?: number
}

interface BoundaryEnumeration {
  polls: PollTarget[]
  skippedNoHost: string[]
  spaceUri: string
  /**
   * Every DID seen in a completed listing, regardless of custody or host.
   * The presence signal for departure detection — `polls` alone only covers
   * the subset that is also pollable, and a DID can be absent from `polls`
   * for reasons (hostless, custody flip) that are not departure.
   */
  memberDids: Set<string>
}

interface BoundaryMembershipState {
  polls: PollTarget[]
  memberDids: Set<string>
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
 * State is in-process and ephemeral, matching the feedgen's index: on
 * restart there is no "last pass," so the first pass computes no removals.
 * A boundary whose enumeration fails mid-pagination keeps its previous poll
 * targets and purges nothing this pass — absence means something only once
 * a complete listing confirms it.
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
  private readonly log: (event: MembershipPassLogEvent) => void
  private readonly onError: (boundary: string, err: unknown) => void
  private readonly maxEnumerationPages: number
  private readonly lastMembership = new Map<string, BoundaryMembershipState>()

  constructor(deps: MembershipTrackerDeps) {
    this.client = deps.client
    this.credentialManager = deps.credentialManager
    this.purger = deps.purger
    this.log = deps.log ?? defaultLog
    this.onError = deps.onError ?? defaultOnError
    this.maxEnumerationPages =
      deps.maxEnumerationPages ?? DEFAULT_MAX_ENUMERATION_PAGES
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
    const settled = await Promise.allSettled(
      boundaryList.map((boundary) => this.enumerateBoundary(boundary)),
    )

    // Departed dids carry the `BoundaryPassSuccess` they departed from
    // directly, so resolving one never needs a second, boundary-keyed lookup
    // back into `outcomes`.
    const left: Array<{
      outcome: BoundaryPassSuccess
      did: string
      spaceUri: string
    }> = []
    const outcomes: BoundaryPassOutcome[] = []
    const nextMembership = new Map(this.lastMembership)
    const completedMembership = new Map<string, BoundaryMembershipState>()

    settled.forEach((result, i) => {
      const boundary = boundaryList[i]
      const previous = this.lastMembership.get(boundary)
      if (result.status === 'rejected') {
        outcomes.push({
          boundary,
          ok: false,
          polls: previous?.polls ?? [],
          error: result.reason,
        })
        return
      }

      const { polls, skippedNoHost, memberDids, spaceUri } = result.value
      const membership = { polls, memberDids }
      nextMembership.set(boundary, membership)
      completedMembership.set(boundary, membership)

      const outcome: BoundaryPassSuccess = {
        boundary,
        ok: true,
        polls,
        skippedNoHost: skippedNoHost.length,
        removed: [],
      }
      // A DID absent from `polls` may simply be hostless this pass, or have
      // flipped custody away from `pds` — neither is a departure. Only a DID
      // missing from the completed listing entirely has left.
      for (const did of previous?.memberDids ?? []) {
        if (!memberDids.has(did)) {
          left.push({
            outcome,
            did,
            spaceUri,
          })
        }
      }
      outcomes.push(outcome)
    })

    // Resolve global presence against every fresh successful snapshot, so a
    // did that still holds a different tracked boundary this pass is
    // boundary-shrunk, not purged outright. A boundary that failed this pass
    // keeps its stale entry, which counts as "still present" for this check — we
    // have no fresh confirmation that they left, so we do not purge on that
    // boundary's account. Membership is deliberately independent of poll
    // targets: hostless and non-pds members still prevent an actor-wide purge.
    const purgedActor = new Set<string>()
    for (const { outcome, did, spaceUri } of left) {
      const stillMember = [...nextMembership.values()].some((state) =>
        state.memberDids.has(did),
      )
      if (stillMember) {
        await this.purger.purgeSpaceDeparture(did, outcome.boundary, spaceUri)
        outcome.removed.push({ did, scope: 'boundary' })
        continue
      }
      outcome.removed.push({ did, scope: 'actor' })
      if (!purgedActor.has(did)) {
        purgedActor.add(did)
        await this.purger.purgeSpaceActor(did)
      }
    }

    // A completed listing becomes the departure baseline only after all
    // removals derived from it succeed. If a purge fails, retaining the prior
    // snapshots makes the next pass rediscover and retry the same departure.
    for (const [boundary, membership] of completedMembership) {
      this.lastMembership.set(boundary, membership)
    }

    for (const outcome of outcomes) {
      if (!outcome.ok) {
        this.onError(outcome.boundary, outcome.error)
      }
    }
    const successful = outcomes.filter(
      (outcome): outcome is BoundaryPassSuccess => outcome.ok,
    )
    this.log({
      successfulBoundaries: successful.length,
      failedBoundaries: outcomes.length - successful.length,
      pollTargets: successful.reduce(
        (total, outcome) => total + outcome.polls.length,
        0,
      ),
      skippedNoHost: successful.reduce(
        (total, outcome) => total + outcome.skippedNoHost,
        0,
      ),
      removed: successful.reduce(
        (total, outcome) => total + outcome.removed.length,
        0,
      ),
    })

    return outcomes
  }

  private async enumerateBoundary(
    boundary: string,
  ): Promise<BoundaryEnumeration> {
    const credential = await this.credentialManager.getCredential(boundary)
    const polls: PollTarget[] = []
    const skippedNoHost: string[] = []
    const memberDids = new Set<string>()
    let cursor: string | undefined
    let pages = 0
    do {
      pages += 1
      if (pages > this.maxEnumerationPages) {
        throw new MembershipPageLimitError(boundary, this.maxEnumerationPages)
      }
      const page = await this.client.listSpaceRepos(
        { space: credential.spaceUri, cursor, limit: PAGE_LIMIT },
        credential,
      )
      for (const row of page.repos) {
        memberDids.add(row.did)
        // Fail closed: only an explicit 'pds' custody polls. Absent,
        // 'stratos', or any unrecognized value stays with the (unchanged)
        // subscription arm — but the did is still present in the space, so
        // it must not read as departed.
        if (row.custody !== 'pds') continue
        if (!row.host) {
          skippedNoHost.push(row.did)
          continue
        }
        polls.push({
          spaceUri: credential.spaceUri,
          boundary,
          did: row.did,
          host: row.host,
        })
      }
      // A host that returns the same cursor forever would otherwise spin
      // this loop indefinitely without ever tripping the page ceiling above.
      if (page.cursor !== undefined && page.cursor === cursor) {
        throw new MembershipCursorStalledError(boundary, page.cursor)
      }
      cursor = page.cursor
    } while (cursor !== undefined)
    return {
      polls,
      skippedNoHost,
      spaceUri: credential.spaceUri,
      memberDids,
    }
  }
}

function defaultLog(event: MembershipPassLogEvent): void {
  console.log(
    JSON.stringify({ msg: 'feedgen.space-membership-pass', ...event }),
  )
}

function defaultOnError(boundary: string, err: unknown): void {
  console.error(`space membership pass failed for boundary ${boundary}:`, err)
}
