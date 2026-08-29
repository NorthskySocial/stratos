import type { Keypair } from '@atproto/crypto'
import { boundaryToSpaceUri } from '@northskysocial/stratos-core'
import type { UpstreamStratosClient } from '../upstream/index.js'
import {
  createDpopProof,
  generateDpopKeyPair,
  type DpopKeyPair,
} from './dpop.js'
import { mintDelegationToken } from './delegation.js'

/**
 * Holds and refreshes the space credential this feedgen needs to read a
 * member's repo as a spaces syncer (consumed by MM-06; not wired into the
 * sync path here).
 *
 * One credential is held per boundary, bound to a single DPoP key generated
 * once for the manager's lifetime. Mints a fresh credential on first use,
 * then reuses it until it is within {@link refreshMarginMs} of expiring —
 * it does not refresh on every call.
 */

/**
 * Space type NSID this manager requests credentials for. Mirrors
 * `stratos-service/src/oauth/client.ts`'s `SPACE_TYPE` — the only space type
 * Stratos currently hosts.
 */
const SPACE_TYPE = 'zone.stratos.space.feed'

/** Refresh once within this many ms of expiry. Small relative to the 2h server-side default TTL. */
export const DEFAULT_REFRESH_MARGIN_MS = 5 * 60_000

/**
 * Fraction of {@link SpaceCredentialManagerOptions.refreshMarginMs} spread as
 * random jitter, drawn once per credential at mint time. Every boundary
 * warmed at startup would otherwise share the same expiry-derived refresh
 * instant and become due for refresh in the same tick.
 */
const JITTER_FRACTION = 0.1

export interface SpaceCredentialManagerOptions {
  client: Pick<UpstreamStratosClient, 'getSpaceCredential'>
  /** The feedgen's own signing key — mints the self-authorizing delegation token. */
  signingKey: Keypair
  /** The feedgen's `did:web` identity. */
  feedgenDid: string
  /** The Stratos space authority's DID. */
  authorityDid: string
  /** Refresh once a held credential is within this many ms of expiry. */
  refreshMarginMs?: number
  /** Injectable clock for tests. */
  now?: () => number
  /** Injectable DPoP key pair for tests; generated lazily otherwise. */
  dpopKeyPair?: DpopKeyPair
  /** Injectable jitter source for tests. Returns a value in `[0, 1)`, like `Math.random`. */
  random?: () => number
}

/** A held, still-valid space credential and the means to present it. */
export interface HeldSpaceCredential {
  readonly boundary: string
  readonly spaceUri: string
  readonly credential: string
  readonly expiresAt: Date
  /** Build a presentation-proof DPoP header bound to this credential via `ath`. */
  readonly createPresentationProof: (
    htm: string,
    htu: string,
  ) => Promise<string>
}

interface HeldState {
  spaceUri: string
  credential: string
  expiresAtMs: number
  /** Jitter drawn once at mint time; subtracted from the refresh margin. */
  jitterMs: number
}

export class SpaceCredentialManager {
  private readonly client: Pick<UpstreamStratosClient, 'getSpaceCredential'>
  private readonly signingKey: Keypair
  private readonly feedgenDid: string
  private readonly authorityDid: string
  private readonly refreshMarginMs: number
  private readonly now: () => number
  private readonly random: () => number
  private readonly held = new Map<string, HeldState>()
  private readonly inflight = new Map<string, Promise<HeldSpaceCredential>>()
  private dpopKeyPairPromise: Promise<DpopKeyPair> | undefined

  constructor(opts: SpaceCredentialManagerOptions) {
    this.client = opts.client
    this.signingKey = opts.signingKey
    this.feedgenDid = opts.feedgenDid
    this.authorityDid = opts.authorityDid
    this.refreshMarginMs = opts.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS
    this.now = opts.now ?? Date.now
    this.random = opts.random ?? Math.random
    if (opts.dpopKeyPair) {
      this.dpopKeyPairPromise = Promise.resolve(opts.dpopKeyPair)
    }
  }

  /**
   * Get a still-valid credential for `boundary`, minting or refreshing it as
   * needed. Concurrent calls for the same boundary share one mint.
   *
   * Fails closed: a mint failure with no still-valid held credential
   * propagates to the caller rather than fabricating access. A REFRESH
   * failure with a still-valid held credential returns that credential
   * instead — it was already verified and has not expired.
   */
  async getCredential(boundary: string): Promise<HeldSpaceCredential> {
    const existing = this.held.get(boundary)
    if (existing && !this.needsRefresh(existing)) {
      return this.toHeld(boundary, existing)
    }

    const inflight = this.inflight.get(boundary)
    if (inflight) return inflight

    const promise = this.refresh(boundary, existing)
    this.inflight.set(boundary, promise)
    try {
      return await promise
    } finally {
      // Unlike `EnrollmentManager`, nothing else writes to `inflight` for a
      // boundary already in flight — no `invalidate()` exists here to detach
      // an entry — so the slot always still holds this promise.
      this.inflight.delete(boundary)
    }
  }

  private needsRefresh(state: HeldState): boolean {
    return (
      this.now() >= state.expiresAtMs - this.refreshMarginMs - state.jitterMs
    )
  }

  private async refresh(
    boundary: string,
    existing: HeldState | undefined,
  ): Promise<HeldSpaceCredential> {
    try {
      const minted = await this.mint(boundary)
      this.held.set(boundary, minted)
      return this.toHeld(boundary, minted)
    } catch (err) {
      if (existing && this.now() < existing.expiresAtMs) {
        return this.toHeld(boundary, existing)
      }
      throw err
    }
  }

  private async mint(boundary: string): Promise<HeldState> {
    const spaceUriResult = boundaryToSpaceUri(boundary, SPACE_TYPE)
    if (!spaceUriResult.ok) {
      throw new Error(
        `cannot map boundary "${boundary}" to a space URI: ${spaceUriResult.error.message}`,
      )
    }
    const spaceUri = spaceUriResult.value

    const dpopKeyPair = await this.getDpopKeyPair()
    const delegationToken = await mintDelegationToken({
      signingKey: this.signingKey,
      issuerDid: this.feedgenDid,
      spaceUri,
      authorityDid: this.authorityDid,
    })

    const result = await this.client.getSpaceCredential({
      space: spaceUri,
      delegationToken,
      buildMintProof: (htu) =>
        createDpopProof(dpopKeyPair, { htm: 'POST', htu }),
    })

    return {
      spaceUri,
      credential: result.credential,
      expiresAtMs: parseExpiry(result.expiresAt, spaceUri, this.now()),
      jitterMs: this.random() * this.refreshMarginMs * JITTER_FRACTION,
    }
  }

  private async getDpopKeyPair(): Promise<DpopKeyPair> {
    this.dpopKeyPairPromise ??= generateDpopKeyPair()
    return this.dpopKeyPairPromise
  }

  private toHeld(boundary: string, state: HeldState): HeldSpaceCredential {
    const { credential } = state
    return {
      boundary,
      spaceUri: state.spaceUri,
      credential,
      expiresAt: new Date(state.expiresAtMs),
      createPresentationProof: async (htm: string, htu: string) => {
        const dpopKeyPair = await this.getDpopKeyPair()
        return createDpopProof(dpopKeyPair, { htm, htu, credential })
      },
    }
  }
}

/**
 * Parse the credential's expiry, rejecting anything unusable.
 *
 * An unparsed value yields NaN, and every comparison against NaN is false, so
 * the credential would never look due for refresh and never look expired. The
 * manager would then serve it forever. An expiry at or before `nowMs` is a
 * credential that arrives already expired; storing it would return dead
 * access to the caller. Fail closed on both.
 */
function parseExpiry(
  expiresAt: string,
  spaceUri: string,
  nowMs: number,
): number {
  const ms = Date.parse(expiresAt)
  if (!Number.isFinite(ms) || ms <= nowMs) {
    throw new Error(`space credential for ${spaceUri} has an unusable expiry`)
  }
  return ms
}
