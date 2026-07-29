import { importJWK, type JWK } from 'jose'
import type { Logger } from '@northskysocial/stratos-core'

/** A key material usable with jose's `compactVerify` (the import result). */
export type ClientVerifyKey = Awaited<ReturnType<typeof importJWK>>

/**
 * External-client JWKS resolver.
 *
 * Resolves an arbitrary OAuth-style client's public keys so a client
 * attestation can be verified. A `client_id` is an HTTPS URL to a
 * `client-metadata.json` document; that document either embeds its keys inline
 * (`jwks`) or points to a JWKS endpoint (`jwks_uri`). We fetch, extract the key
 * set, and cache it in-memory with a TTL.
 *
 * This is deliberately SEPARATE from `oauth/client.ts`: that module resolves the
 * Stratos service's OWN client metadata through `@atproto/oauth-client-node`.
 * Here we resolve UNTRUSTED, ARBITRARY third-party clients, so the resolver is
 * intentionally minimal and hostile-input-aware:
 *   - HTTPS ONLY. A non-HTTPS `client_id` is rejected outright (never fetched).
 *   - FAIL CLOSED. Any fetch/parse/shape error rejects (no key returned); a
 *     caller that cannot resolve keys must never grant access.
 *   - TTL CACHE. Successful resolutions are cached for `cacheTtlMs` (default
 *     5 minutes) keyed by `client_id`. Failures are NOT cached (so a transient
 *     outage does not pin a client out for the whole TTL).
 */

/** Default JWKS cache TTL (5 minutes). */
export const DEFAULT_JWKS_CACHE_TTL_MS = 5 * 60 * 1000

/**
 * Default timeout (ms) for outbound metadata/JWKS fetches. A slow or
 * unresponsive client_id endpoint is attacker-influencable (the URL comes from
 * the attestation) and must not hold auth requests open indefinitely.
 */
export const DEFAULT_JWKS_FETCH_TIMEOUT_MS = 3000

/**
 * Base class for all JWKS-resolution failures. Distinct subclasses let the
 * attestation verifier (and its tests) discriminate why resolution failed.
 */
export class JwksResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** The `client_id` was not a syntactically valid HTTPS URL. */
export class NonHttpsClientIdError extends JwksResolutionError {}
/** Fetching client-metadata.json or the jwks_uri failed (network / non-2xx). */
export class MetadataFetchError extends JwksResolutionError {}
/** The metadata/JWKS document was not valid JSON or not the expected shape. */
export class MalformedJwksError extends JwksResolutionError {}
/** No key in the resolved JWKS matched the requested `kid`. */
export class UnknownKidError extends JwksResolutionError {}

/** A single JWK as published in a client's key set. */
export interface ClientJwk extends JWK {
  kid?: string
  alg?: string
  use?: string
}

/** A resolved JWKS (the key array only — the shape we cache). */
export interface ClientJwks {
  keys: ClientJwk[]
}

interface ClientMetadata {
  jwks?: unknown
  jwks_uri?: unknown
}

interface CacheEntry {
  keys: ClientJwk[]
  expiresAt: number
}

/** Options for {@link JwksResolver}. */
export interface JwksResolverOptions {
  /** Injectable fetch (for tests / user-agent wrapping). Defaults to global. */
  fetch?: typeof globalThis.fetch
  /** Cache TTL in milliseconds (default {@link DEFAULT_JWKS_CACHE_TTL_MS}). */
  cacheTtlMs?: number
  /** Outbound fetch timeout in ms (default {@link DEFAULT_JWKS_FETCH_TIMEOUT_MS}). */
  fetchTimeoutMs?: number
  /** Optional logger for fail-closed diagnostics. */
  logger?: Logger
  /** Injectable clock (unix ms) for deterministic cache-expiry tests. */
  now?: () => number
}

/**
 * Resolves and caches external clients' JWKS, and imports the key named by a
 * `kid` into a verifiable crypto key.
 */
export class JwksResolver {
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly cacheTtlMs: number
  private readonly fetchTimeoutMs: number
  private readonly logger?: Logger
  private readonly now: () => number
  private readonly cache = new Map<string, CacheEntry>()

  constructor(opts: JwksResolverOptions = {}) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis)
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_JWKS_FETCH_TIMEOUT_MS
    this.logger = opts.logger
    this.now = opts.now ?? (() => Date.now())
  }

  /**
   * Resolve the JWK for `(clientId, kid)` and import it as a verify key.
   *
   * @param clientId - The client's `client_id` (HTTPS URL to metadata).
   * @param kid - The key id named by the attestation header.
   * @param alg - The attestation header `alg`, used when importing the JWK.
   * @returns A crypto key usable with `compactVerify`.
   * @throws {@link NonHttpsClientIdError} if `client_id` is not HTTPS.
   * @throws {@link MetadataFetchError} on any fetch failure (fail closed).
   * @throws {@link MalformedJwksError} on malformed metadata / JWKS.
   * @throws {@link UnknownKidError} if no key matches `kid`.
   */
  async resolveKey(
    clientId: string,
    kid: string,
    alg: string,
  ): Promise<ClientVerifyKey> {
    const keys = await this.resolveJwks(clientId)
    const jwk = keys.find((k) => k.kid === kid)
    if (!jwk) {
      throw new UnknownKidError(
        `No key with kid "${kid}" in JWKS for client "${clientId}"`,
      )
    }
    try {
      return await importJWK(jwk, jwk.alg ?? alg)
    } catch (err) {
      throw new MalformedJwksError(
        `Could not import JWK "${kid}" for client "${clientId}": ${errMessage(err)}`,
      )
    }
  }

  /**
   * Resolve (and cache) the full key set for a `client_id`.
   *
   * A cached, unexpired entry is returned without any network call. On a miss
   * we validate the `client_id` is HTTPS, fetch metadata, extract keys from
   * `jwks` (inline) or `jwks_uri` (fetched), cache, and return.
   *
   * @throws {@link NonHttpsClientIdError} / {@link MetadataFetchError} /
   *   {@link MalformedJwksError} — fail closed on every error path.
   */
  async resolveJwks(clientId: string): Promise<ClientJwk[]> {
    const cached = this.cache.get(clientId)
    if (cached && cached.expiresAt > this.now()) {
      return cached.keys
    }

    const url = this.requireHttpsUrl(clientId)
    const metadata = await this.fetchJson<ClientMetadata>(
      url,
      'client-metadata.json',
    )
    const keys = await this.extractKeys(clientId, metadata)

    this.cache.set(clientId, {
      keys,
      expiresAt: this.now() + this.cacheTtlMs,
    })
    return keys
  }

  /**
   * Parse `client_id` as a URL and require the `https:` scheme. Any non-HTTPS
   * `client_id` (incl. `http:`) is rejected WITHOUT a fetch. The host must
   * also not be an obviously non-public destination (localhost or a
   * loopback/private/link-local IP literal) — see {@link assertPublicHost}.
   */
  private requireHttpsUrl(clientId: string): URL {
    let url: URL
    try {
      url = new URL(clientId)
    } catch {
      throw new NonHttpsClientIdError(
        `client_id is not a valid URL: "${clientId}"`,
      )
    }
    if (url.protocol !== 'https:') {
      throw new NonHttpsClientIdError(
        `client_id must be an https URL, got "${url.protocol}//": "${clientId}"`,
      )
    }
    assertPublicHost(url)
    return url
  }

  /**
   * Extract the key array from metadata: inline `jwks.keys` takes precedence;
   * otherwise `jwks_uri` is fetched (HTTPS-only) and its `keys` used.
   */
  private async extractKeys(
    clientId: string,
    metadata: ClientMetadata,
  ): Promise<ClientJwk[]> {
    const inline = metadata.jwks
    if (inline !== undefined) {
      return this.asKeyArray(clientId, inline)
    }

    if (typeof metadata.jwks_uri === 'string') {
      const jwksUrl = this.requireHttpsUrl(metadata.jwks_uri)
      const doc = await this.fetchJson<unknown>(jwksUrl, 'jwks_uri')
      return this.asKeyArray(clientId, doc)
    }

    throw new MalformedJwksError(
      `client "${clientId}" metadata declares neither jwks nor jwks_uri`,
    )
  }

  /** Coerce an unknown JWKS document into a non-empty `keys` array. */
  private asKeyArray(clientId: string, doc: unknown): ClientJwk[] {
    if (
      !doc ||
      typeof doc !== 'object' ||
      !Array.isArray((doc as { keys?: unknown }).keys)
    ) {
      throw new MalformedJwksError(
        `client "${clientId}" JWKS is missing a "keys" array`,
      )
    }
    const keys = (doc as { keys: unknown[] }).keys.filter(
      (k): k is ClientJwk => !!k && typeof k === 'object',
    )
    if (keys.length === 0) {
      throw new MalformedJwksError(`client "${clientId}" JWKS "keys" is empty`)
    }
    return keys
  }

  /**
   * Fetch and JSON-parse a document, failing closed on network error, non-2xx,
   * or malformed JSON.
   */
  private async fetchJson<T>(url: URL, what: string): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(url.toString(), {
        headers: { accept: 'application/json' },
        // Bounded: the URL is attacker-influencable; a hung endpoint must not
        // pin the auth request. Timeouts surface as MetadataFetchError below.
        signal: AbortSignal.timeout(this.fetchTimeoutMs),
        // SSRF: refuse redirects outright — a public metadata URL must not be
        // able to bounce the fetch to an internal destination. (Residual: DNS
        // rebinding needs resolver-level pinning, out of scope here.)
        redirect: 'error',
      })
    } catch (err) {
      this.logger?.warn(
        { err: errMessage(err), url: url.toString() },
        `client-attestation ${what} fetch failed; failing closed`,
      )
      throw new MetadataFetchError(
        `Failed to fetch ${what} from "${url.toString()}": ${errMessage(err)}`,
      )
    }
    if (!res.ok) {
      throw new MetadataFetchError(
        `Fetching ${what} from "${url.toString()}" returned HTTP ${res.status}`,
      )
    }
    try {
      return (await res.json()) as T
    } catch (err) {
      throw new MalformedJwksError(
        `${what} from "${url.toString()}" was not valid JSON: ${errMessage(err)}`,
      )
    }
  }
}

/** Best-effort error message extraction. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Reject URLs whose host is an obviously non-public destination: `localhost`
 * (and subdomains), an IPv4 literal in a loopback/private/link-local/CGNAT/
 * benchmark range, or an IPv6 loopback/unspecified/link-local/unique-local/
 * v4-mapped literal. These URLs come from attacker-supplied attestations and
 * must not let the service fetch its own internal network (SSRF).
 *
 * Residual: a public hostname that RESOLVES to an internal address (DNS
 * rebinding) is not caught here — that requires resolver-level pinning.
 */
function assertPublicHost(url: URL): void {
  // Node's URL keeps the brackets on IPv6 literals in `hostname`.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const deny = (why: string): never => {
    throw new NonHttpsClientIdError(
      `client metadata host "${host}" is not a public destination (${why})`,
    )
  }

  if (host === 'localhost' || host.endsWith('.localhost')) deny('localhost')

  // IPv6 literal (URL.hostname strips the brackets).
  if (host.includes(':')) {
    if (host === '::' || host === '::1') deny('IPv6 loopback/unspecified')
    if (/^fe[89ab]/.test(host)) deny('IPv6 link-local')
    if (/^f[cd]/.test(host)) deny('IPv6 unique-local')
    if (host.startsWith('::ffff:')) deny('IPv4-mapped IPv6')
    return
  }

  // IPv4 literal.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 0) deny('unspecified range')
  if (a === 10) deny('private range')
  if (a === 127) deny('loopback')
  if (a === 169 && b === 254) deny('link-local')
  if (a === 172 && b >= 16 && b <= 31) deny('private range')
  if (a === 192 && b === 168) deny('private range')
  if (a === 100 && b >= 64 && b <= 127) deny('carrier-grade NAT range')
  if (a === 198 && (b === 18 || b === 19)) deny('benchmark range')
}
