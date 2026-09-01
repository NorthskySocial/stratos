export interface SpaceAuthorizationLease {
  readonly spaceUri: string
  readonly did: string
  readonly generation: number
  /** Present only on the per-run lease consumed by store mutations. */
  readonly runGeneration?: number
}

export interface SpaceAuthorizationTarget {
  readonly spaceUri: string
  readonly boundary: string
  readonly did: string
  readonly lease?: SpaceAuthorizationLease
}

export interface SpaceAuthorizationSnapshot {
  readonly boundary: string
  readonly spaceUri: string
  readonly dids: readonly string[]
  readonly revocationEpoch: number
}

export interface DidMutationScope {
  readonly did: string
}

interface AuthorizationState {
  boundary: string
  generation: number
  runGeneration: number
  authorized: boolean
}

/** Raised when a queued mutation wakes after its membership lease was revoked. */
export class SpaceAuthorizationRevokedError extends Error {
  constructor(target: SpaceAuthorizationTarget) {
    super(
      `space authorization was revoked for ${target.did} in ${target.spaceUri}`,
    )
    this.name = 'SpaceAuthorizationRevokedError'
  }
}

/**
 * Serializes feed-index mutations per actor and owns the in-process lease that
 * authorizes `(space, actor)` writes.
 *
 * Network calls deliberately happen outside this class. A mutation enters the
 * DID fence only when it is ready to touch the store, then checks the exact
 * lease again. Revocation enters the same fence, invalidates the lease first,
 * performs the purge, and only then releases the next queued mutation.
 */
export class SpaceMutationFence {
  private readonly states = new Map<string, Map<string, AuthorizationState>>()
  private readonly boundaryRevokedAt = new Map<string, number>()
  private readonly didTails = new Map<string, Promise<void>>()
  private readonly activeScopes = new WeakSet<DidMutationScope>()
  private revocationEpoch = 0
  private globalRevokedAt = 0
  private leaseGeneration = 0
  private runLeaseGeneration = 0
  private readonly pendingDidMutations = new Map<string, number>()

  /** Capture before `listSpaceRepos`; only that completed snapshot may grant. */
  captureRevocationEpoch(): number {
    return this.revocationEpoch
  }

  /** Register before a live callback waits for the DID scope. */
  beginDidMutation(did: string): void {
    this.pendingDidMutations.set(
      did,
      (this.pendingDidMutations.get(did) ?? 0) + 1,
    )
  }

  endDidMutation(did: string): void {
    const pending = this.pendingDidMutations.get(did)
    if (pending === undefined) {
      throw new Error(`no pending DID mutation for ${did}`)
    }
    if (pending === 1) {
      this.pendingDidMutations.delete(did)
    } else {
      this.pendingDidMutations.set(did, pending - 1)
    }
  }

  hasPendingDidMutation(did: string): boolean {
    return this.pendingDidMutations.has(did)
  }

  /**
   * Commit a fully enumerated space snapshot and issue leases for its members.
   * A revocation that affected a candidate after enumeration began wins, so
   * the stale candidate is omitted until a later clean snapshot refreshes it.
   */
  async authorizeSnapshot(
    snapshot: SpaceAuthorizationSnapshot,
  ): Promise<ReadonlyMap<string, SpaceAuthorizationLease>> {
    const candidates = new Set(snapshot.dids)
    const known = this.states.get(snapshot.spaceUri)
    const dids = new Set(candidates)
    for (const [did, state] of known ?? []) {
      if (state.boundary === snapshot.boundary) dids.add(did)
    }

    const leases = new Map<string, SpaceAuthorizationLease>()
    const departed = [...dids].filter((did) => !candidates.has(did))
    const staleBeforeDepartures = this.wasRevokedSince(snapshot)
    const epochBeforeDepartures = this.revocationEpoch
    await Promise.all(
      departed.map((did) =>
        this.runForDid(did, async () => {
          this.revokeExactState(snapshot.spaceUri, snapshot.boundary, did)
        }),
      ),
    )
    const commitEpoch = this.revocationEpoch
    const snapshotInvalidated =
      staleBeforeDepartures ||
      commitEpoch !== epochBeforeDepartures + departed.length
    await Promise.all(
      [...candidates].map((did) =>
        this.runForDid(did, async () => {
          if (
            snapshotInvalidated ||
            this.wasBoundaryRevokedSince(snapshot.boundary, commitEpoch)
          ) {
            return
          }

          const state = this.getOrCreateState(
            snapshot.spaceUri,
            snapshot.boundary,
            did,
          )
          state.boundary = snapshot.boundary
          state.generation = this.nextLeaseGeneration()
          state.authorized = true
          leases.set(did, {
            spaceUri: snapshot.spaceUri,
            did,
            generation: state.generation,
          })
        }),
      ),
    )
    return leases
  }

  /** Run one forward store mutation after checking signal and exact lease. */
  async mutate<T>(
    target: SpaceAuthorizationTarget,
    signal: AbortSignal | undefined,
    mutation: () => Promise<T>,
  ): Promise<T> {
    return this.runForDid(target.did, async () => {
      signal?.throwIfAborted()
      this.assertMutationAuthorized(target)
      return mutation()
    })
  }

  /**
   * Compensate a previously completed cursor mutation after cancellation.
   * Cancellation is why this runs, so it checks only the lease inside the
   * fence. A concurrent purge makes that lease stale and blocks compensation.
   */
  async compensate<T>(
    target: SpaceAuthorizationTarget,
    mutation: () => Promise<T>,
  ): Promise<T> {
    return this.runForDid(target.did, async () => {
      this.assertMutationAuthorized(target)
      return mutation()
    })
  }

  /**
   * Rotate the mutation lease for one scheduler dispatch. The membership
   * generation is not refreshed here, so a revoked stale target cannot become
   * authorized merely because a failed enumeration dispatched it again.
   */
  async issueRunLease<T extends SpaceAuthorizationTarget>(
    target: T,
  ): Promise<T> {
    return this.runForDid(target.did, async () => {
      const state = this.assertMembershipAuthorized(target)
      state.runGeneration = this.nextRunLeaseGeneration()
      return {
        ...target,
        lease: {
          spaceUri: target.spaceUri,
          did: target.did,
          generation: state.generation,
          runGeneration: state.runGeneration,
        },
      }
    })
  }

  async revokeActor<T>(did: string, purge: () => Promise<T>): Promise<T> {
    this.markGlobalRevoked()
    return this.withDidScope(did, (scope) =>
      this.revokeActorState(scope, purge),
    )
  }

  async revokeActorWithinScope<T>(
    scope: DidMutationScope,
    purge: () => Promise<T>,
  ): Promise<T> {
    this.markGlobalRevoked()
    return this.revokeActorState(scope, purge)
  }

  private async revokeActorState<T>(
    scope: DidMutationScope,
    purge: () => Promise<T>,
  ): Promise<T> {
    this.assertScope(scope)
    for (const [spaceUri, byDid] of this.states) {
      byDid.delete(scope.did)
      this.pruneSpace(spaceUri, byDid)
    }
    return purge()
  }

  async revokeBoundary<T>(
    did: string,
    boundary: string,
    purge: () => Promise<T>,
  ): Promise<T> {
    this.markBoundaryRevoked(boundary)
    return this.withDidScope(did, (scope) =>
      this.revokeBoundaryState(scope, boundary, purge),
    )
  }

  async revokeBoundaryWithinScope<T>(
    scope: DidMutationScope,
    boundary: string,
    purge: () => Promise<T>,
  ): Promise<T> {
    this.markBoundaryRevoked(boundary)
    return this.revokeBoundaryState(scope, boundary, purge)
  }

  private async revokeBoundaryState<T>(
    scope: DidMutationScope,
    boundary: string,
    purge: () => Promise<T>,
  ): Promise<T> {
    this.assertScope(scope)
    for (const [spaceUri, byDid] of this.states) {
      if (byDid.get(scope.did)?.boundary === boundary) {
        byDid.delete(scope.did)
        this.pruneSpace(spaceUri, byDid)
      }
    }
    return purge()
  }

  async revokeBoundaryForAll<T>(
    boundary: string,
    purge: () => Promise<T>,
  ): Promise<T> {
    this.markBoundaryRevoked(boundary)
    const dids = new Set<string>()
    for (const bySpace of this.states.values()) {
      for (const [did, state] of bySpace) {
        if (state.boundary === boundary) dids.add(did)
      }
    }
    return this.runForDids([...dids].sort(), async () => {
      for (const [spaceUri, byDid] of this.states) {
        for (const [did, state] of byDid) {
          if (state.boundary === boundary) byDid.delete(did)
        }
        this.pruneSpace(spaceUri, byDid)
      }
      return purge()
    })
  }

  async revokeSpace<T>(
    did: string,
    boundary: string,
    spaceUri: string,
    purge: () => Promise<T>,
  ): Promise<T> {
    this.markBoundaryRevoked(boundary)
    return this.withDidScope(did, (scope) => {
      this.assertScope(scope)
      this.deleteExactState(spaceUri, did)
      return purge()
    })
  }

  async revokeSpaceWithinScope<T>(
    scope: DidMutationScope,
    boundary: string,
    spaceUri: string,
    purge: () => Promise<T>,
  ): Promise<T> {
    this.assertScope(scope)
    this.markBoundaryRevoked(boundary)
    this.deleteExactState(spaceUri, scope.did)
    return purge()
  }

  /** A late verifier may revoke only the exact run generation it verified. */
  async revokeSpaceForRun<T>(
    target: SpaceAuthorizationTarget,
    purge: () => Promise<T>,
  ): Promise<T> {
    this.markBoundaryRevoked(target.boundary)
    return this.runForDid(target.did, async () => {
      this.assertMutationAuthorized(target)
      this.deleteExactState(target.spaceUri, target.did)
      return purge()
    })
  }

  private wasRevokedSince(snapshot: SpaceAuthorizationSnapshot): boolean {
    return this.wasBoundaryRevokedSince(
      snapshot.boundary,
      snapshot.revocationEpoch,
    )
  }

  private wasBoundaryRevokedSince(boundary: string, epoch: number): boolean {
    return (
      Math.max(
        this.globalRevokedAt,
        this.boundaryRevokedAt.get(boundary) ?? 0,
      ) > epoch
    )
  }

  private assertMembershipAuthorized(
    target: SpaceAuthorizationTarget,
  ): AuthorizationState {
    const state = this.states.get(target.spaceUri)?.get(target.did)
    const lease = target.lease
    if (
      lease?.spaceUri !== target.spaceUri ||
      lease.did !== target.did ||
      !state?.authorized ||
      state.boundary !== target.boundary ||
      state.generation !== lease.generation
    ) {
      throw new SpaceAuthorizationRevokedError(target)
    }
    return state
  }

  private assertMutationAuthorized(
    target: SpaceAuthorizationTarget,
  ): AuthorizationState {
    const state = this.assertMembershipAuthorized(target)
    if (
      target.lease?.runGeneration === undefined ||
      state.runGeneration !== target.lease.runGeneration
    ) {
      throw new SpaceAuthorizationRevokedError(target)
    }
    return state
  }

  private revokeExactState(
    spaceUri: string,
    boundary: string,
    did: string,
  ): void {
    this.markBoundaryRevoked(boundary)
    this.deleteExactState(spaceUri, did)
  }

  private deleteExactState(spaceUri: string, did: string): void {
    const byDid = this.states.get(spaceUri)
    byDid?.delete(did)
    if (byDid) this.pruneSpace(spaceUri, byDid)
  }

  private nextRevocationEpoch(): number {
    this.revocationEpoch += 1
    return this.revocationEpoch
  }

  private markGlobalRevoked(): void {
    this.globalRevokedAt = this.nextRevocationEpoch()
  }

  private markBoundaryRevoked(boundary: string): void {
    this.boundaryRevokedAt.set(boundary, this.nextRevocationEpoch())
  }

  private nextLeaseGeneration(): number {
    this.leaseGeneration += 1
    return this.leaseGeneration
  }

  private nextRunLeaseGeneration(): number {
    this.runLeaseGeneration += 1
    return this.runLeaseGeneration
  }

  private getOrCreateState(
    spaceUri: string,
    boundary: string,
    did: string,
  ): AuthorizationState {
    const byDid =
      this.states.get(spaceUri) ?? new Map<string, AuthorizationState>()
    const state: AuthorizationState = byDid.get(did) ?? {
      boundary,
      generation: 0,
      runGeneration: 0,
      authorized: false,
    }
    byDid.set(did, state)
    this.states.set(spaceUri, byDid)
    return state
  }

  private pruneSpace(
    spaceUri: string,
    byDid: ReadonlyMap<string, AuthorizationState>,
  ): void {
    if (byDid.size === 0) this.states.delete(spaceUri)
  }

  private async runForDid<T>(
    did: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withDidScope(did, () => operation())
  }

  async withDidScope<T>(
    did: string,
    operation: (scope: DidMutationScope) => Promise<T>,
  ): Promise<T> {
    const previous = this.didTails.get(did) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => gate)
    this.didTails.set(did, tail)

    await previous
    const scope: DidMutationScope = { did }
    this.activeScopes.add(scope)
    try {
      return await operation(scope)
    } finally {
      this.activeScopes.delete(scope)
      release()
      if (this.didTails.get(did) === tail) this.didTails.delete(did)
    }
  }

  private assertScope(scope: DidMutationScope): void {
    if (!this.activeScopes.has(scope)) {
      throw new Error('DID mutation scope is not active')
    }
  }

  private async runForDids<T>(
    dids: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const [did, ...rest] = dids
    if (!did) return operation()
    return this.runForDid(did, () => this.runForDids(rest, operation))
  }
}
