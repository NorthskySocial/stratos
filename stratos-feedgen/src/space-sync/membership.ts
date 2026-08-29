import type { Purger } from '../purge/index.js'
import type { SpaceCredentialManager } from '../space-credential/index.js'
import type { UpstreamStratosClient } from '../upstream/index.js'

/** Rows requested per `listSpaceRepos` page. The lexicon's own maximum. */
const PAGE_LIMIT = 1000

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
   * `'boundary'`: still a poll target in another tracked boundary, purged
   * via `purgeActorBoundary`. `'actor'`: gone from every tracked boundary,
   * purged via `purgeActor`.
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
  boundary: string
  memberCount: number
  skippedNoHost: number
  removed: number
}

export interface MembershipTrackerDeps {
  client: Pick<UpstreamStratosClient, 'listSpaceRepos'>
  credentialManager: Pick<SpaceCredentialManager, 'getCredential'>
  purger: Pick<Purger, 'purgeActor' | 'purgeActorBoundary'>
  /** Structured per-boundary summary sink. Defaults to `console.log(JSON.stringify(...))`. */
  log?: (event: MembershipPassLogEvent) => void
  /** Called when a boundary's enumeration fails this pass. Defaults to `console.error`. */
  onError?: (boundary: string, err: unknown) => void
}

interface BoundaryEnumeration {
  polls: PollTarget[]
  skippedNoHost: string[]
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
  private readonly purger: Pick<Purger, 'purgeActor' | 'purgeActorBoundary'>
  private readonly log: (event: MembershipPassLogEvent) => void
  private readonly onError: (boundary: string, err: unknown) => void
  private readonly lastPolls = new Map<string, PollTarget[]>()

  constructor(deps: MembershipTrackerDeps) {
    this.client = deps.client
    this.credentialManager = deps.credentialManager
    this.purger = deps.purger
    this.log = deps.log ?? defaultLog
    this.onError = deps.onError ?? defaultOnError
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
    const left: Array<{ outcome: BoundaryPassSuccess; did: string }> = []
    const outcomes: BoundaryPassOutcome[] = []

    settled.forEach((result, i) => {
      const boundary = boundaryList[i]
      const previous = this.lastPolls.get(boundary) ?? []
      if (result.status === 'rejected') {
        outcomes.push({
          boundary,
          ok: false,
          polls: previous,
          error: result.reason,
        })
        return
      }

      const { polls, skippedNoHost } = result.value
      this.lastPolls.set(boundary, polls)

      const outcome: BoundaryPassSuccess = {
        boundary,
        ok: true,
        polls,
        skippedNoHost: skippedNoHost.length,
        removed: [],
      }
      const previousDids = new Set(previous.map((p) => p.did))
      const currentDids = new Set(polls.map((p) => p.did))
      for (const did of previousDids) {
        if (!currentDids.has(did)) left.push({ outcome, did })
      }
      outcomes.push(outcome)
    })

    // Resolve global presence only after every succeeded boundary above has
    // published its fresh poll targets, so a did that still holds a
    // different tracked boundary this pass is boundary-shrunk, not purged
    // outright. A boundary that failed this pass keeps its stale entry in
    // `lastPolls`, which counts as "still present" for this check — we have
    // no fresh confirmation that they left, so we do not purge on that
    // boundary's account.
    const purgedActor = new Set<string>()
    for (const { outcome, did } of left) {
      const stillMember = [...this.lastPolls.values()].some((polls) =>
        polls.some((p) => p.did === did),
      )
      if (stillMember) {
        await this.purger.purgeActorBoundary(
          did,
          outcome.boundary,
          'space-boundary-shrink',
        )
        outcome.removed.push({ did, scope: 'boundary' })
        continue
      }
      outcome.removed.push({ did, scope: 'actor' })
      if (!purgedActor.has(did)) {
        purgedActor.add(did)
        await this.purger.purgeActor(did, 'space-unenroll')
      }
    }

    for (const outcome of outcomes) {
      if (outcome.ok) {
        this.log({
          boundary: outcome.boundary,
          memberCount: outcome.polls.length,
          skippedNoHost: outcome.skippedNoHost,
          removed: outcome.removed.length,
        })
      } else {
        this.onError(outcome.boundary, outcome.error)
      }
    }

    return outcomes
  }

  private async enumerateBoundary(
    boundary: string,
  ): Promise<BoundaryEnumeration> {
    const credential = await this.credentialManager.getCredential(boundary)
    const polls: PollTarget[] = []
    const skippedNoHost: string[] = []
    let cursor: string | undefined
    do {
      const page = await this.client.listSpaceRepos(
        { space: credential.spaceUri, cursor, limit: PAGE_LIMIT },
        credential,
      )
      for (const row of page.repos) {
        // Fail closed: only an explicit 'pds' custody polls. Absent,
        // 'stratos', or any unrecognized value stays with the (unchanged)
        // subscription arm.
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
      cursor = page.cursor
    } while (cursor !== undefined)
    return { polls, skippedNoHost }
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
