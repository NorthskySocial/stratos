import type { Keypair } from '@atproto/crypto'
import type { Logger } from '@northskysocial/stratos-core'
import type { ActorStore } from '../../actor-store-types.js'

/**
 * A bound signing function for a single actor. Callers that need to hand a
 * signer to lower layers (e.g. commit signing) receive one of these instead of
 * a {@link Keypair}, so raw private key material never leaves this module.
 */
export type ActorSignFn = (bytes: Uint8Array) => Promise<Uint8Array>

/**
 * The single seam through which every per-actor signing operation flows.
 *
 * Raw private key material (a {@link Keypair}) is confined to the implementation
 * of this interface. Outside `infra/signing/`, only public keys and signatures
 * cross the boundary.
 *
 * NOTE: signing volume will scale with reads post-cutover; keep this interface
 * async and batchable. (No batching is implemented yet — the shape is reserved
 * so a batched backend can be dropped in without touching call sites.)
 */
export interface ActorSigner {
  /**
   * Produce a signature over `bytes` with the actor's private key. Creates the
   * key if the actor does not yet have one (matching the historical
   * load-or-create behavior).
   */
  sign(did: string, bytes: Uint8Array): Promise<Uint8Array>

  /**
   * The actor's public signing key as a `did:key` string — the representation
   * enrollment records and the OAuth callback consume today.
   */
  getPublicKey(did: string): Promise<string>

  /** Create the actor's signing key if absent (load-or-create). */
  ensureKey(did: string): Promise<void>

  /**
   * A signing function bound to `did`. Handed to lower layers that must sign
   * without ever holding key material. Ensures the key exists first.
   */
  getSignFn(did: string): Promise<ActorSignFn>
}

const DEFAULT_SIGNING_KEY_TTL_MS = 5 * 60 * 1000

/**
 * In-process {@link ActorSigner} backed by the actor key-store.
 *
 * The key STORAGE mechanism is unchanged — this only reroutes access so that
 * `Keypair`s (private material) are loaded, cached, and used exclusively here.
 * A short TTL cache avoids redundant DB lookups and P-256 key imports on every
 * write.
 */
export class InProcessActorSigner implements ActorSigner {
  private readonly cache = new Map<
    string,
    { key: Keypair; expiresAt: number }
  >()

  constructor(
    private readonly actorStore: ActorStore,
    private readonly opts: { ttlMs?: number; logger?: Logger } = {},
  ) {}

  async sign(did: string, bytes: Uint8Array): Promise<Uint8Array> {
    const key = await this.loadOrCreate(did)
    const sig = await key.sign(bytes)
    this.opts.logger?.debug(
      { did, bytes: bytes.length },
      'actor commit signature produced',
    )
    return sig
  }

  async getPublicKey(did: string): Promise<string> {
    const key = await this.loadOrCreate(did)
    return key.did()
  }

  async ensureKey(did: string): Promise<void> {
    await this.loadOrCreate(did)
  }

  async getSignFn(did: string): Promise<ActorSignFn> {
    // Resolve (and thereby create-if-absent + warm the cache) up front so the
    // returned closure only performs the signature, keeping the private key
    // out of the caller's reach.
    await this.loadOrCreate(did)
    return (bytes: Uint8Array) => this.sign(did, bytes)
  }

  private async loadOrCreate(did: string): Promise<Keypair> {
    const now = Date.now()
    const cached = this.cache.get(did)
    if (cached && cached.expiresAt > now) {
      return cached.key
    }
    // The ONLY place the private-key-returning key-store methods are called.
    const key =
      (await this.actorStore.loadSigningKey(did)) ??
      (await this.actorStore.createSigningKey(did))
    this.cache.set(did, {
      key,
      expiresAt: now + (this.opts.ttlMs ?? DEFAULT_SIGNING_KEY_TTL_MS),
    })
    return key
  }
}
