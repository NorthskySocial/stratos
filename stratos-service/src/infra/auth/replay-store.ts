import type { Logger } from '@northskysocial/stratos-core'

/**
 * The atomic set-if-absent primitive the replay store depends on.
 *
 * This is the exact shape provided by {@link import('../storage/redis-cache.js').RedisCache.setNxEx},
 * factored into its own interface so the store can be unit-tested and so a
 * Redis-down failure can be simulated by rejecting this call. The contract is:
 * `setNxEx` resolves `true` iff the key was newly created (atomically, via
 * `SET key value EX ttl NX`), `false` if it already existed, and rejects iff
 * the backing store is unavailable.
 */
export interface NxExStore {
  setNxEx(key: string, value: string, ttlSeconds: number): Promise<boolean>
}

/**
 * A single-use nonce store backed by an atomic `SET NX EX` primitive.
 *
 * `consumeOnce(kind, jti, ttl)` returns `true` exactly once per `(kind, jti)`
 * pair — the first caller "wins" and every subsequent caller (within the TTL
 * window) loses. Atomicity under concurrency is provided entirely by the
 * underlying `SET key NX EX ttl` command: only one caller can create the key,
 * so the store is multi-instance-safe by construction (no read-modify-write,
 * no lock).
 *
 * IMPORTANT — durability boundary: "single-use" holds only as far as the
 * backing store's persistence. Once the key's TTL elapses (or the store loses
 * the key, e.g. eviction/flush), the same `(kind, jti)` can be consumed again.
 * The TTL must therefore be chosen to cover the full window in which a token
 * could still be presented (token exp window + max clock skew).
 *
 * Fail-closed: if the backing store is unavailable, `consumeOnce` returns
 * `false` (treating the nonce as already-consumed / un-grantable) and logs. A
 * replay check that cannot run must never grant use.
 */
export class ReplayStore {
  /**
   * @param store - The atomic NX-EX primitive (e.g. `RedisCache`).
   * @param logger - Optional logger for fail-closed diagnostics.
   */
  constructor(
    private readonly store: NxExStore,
    private readonly logger?: Logger,
  ) {}

  /**
   * Attempt to consume a nonce exactly once.
   *
   * @param kind - Namespace for the nonce (keeps distinct token classes from
   *   colliding, e.g. `"space-delegation"`). Forms the key prefix.
   * @param jti - The nonce (JWT `jti` claim) to consume.
   * @param ttlSeconds - How long the consumption is remembered. Must be at
   *   least the token's exp window plus the maximum clock skew, so a token can
   *   never outlive its replay record.
   * @returns `true` iff this call is the first to consume `(kind, jti)`;
   *   `false` on replay OR when the backing store is unavailable (fail-closed).
   */
  async consumeOnce(
    kind: string,
    jti: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const key = replayKey(kind, jti)
    try {
      return await this.store.setNxEx(key, '1', ttlSeconds)
    } catch (err) {
      // Fail closed: an unavailable replay store must not grant use.
      this.logger?.error(
        { err, kind },
        'replay store unavailable; failing closed (denying nonce consumption)',
      )
      return false
    }
  }
}

/**
 * Namespaced replay key. The `kind` prefix isolates token classes so unrelated
 * nonces cannot collide.
 */
function replayKey(kind: string, jti: string): string {
  return `replay:${kind}:${jti}`
}
