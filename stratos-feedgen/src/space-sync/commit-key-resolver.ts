import {
  DidWebResolver,
  PoorlyFormattedDidError,
  UnsupportedDidWebPathError,
  type DidCache,
} from '@atproto/identity'

const DEFAULT_DID_WEB_TIMEOUT_MS = 3_000
const DID_WEB_DOCUMENT_PATH = '/.well-known/did.json'

export interface CommitKeyResolver {
  resolveAtprotoKey: (did: string, forceRefresh?: boolean) => Promise<string>
}

export interface CommitKeyResolverSource extends CommitKeyResolver {
  readonly cache?: DidCache
}

export interface CommitKeyResolverOptions {
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

/**
 * Preserves retryable HTTP status codes for commit-key `did:web` lookups.
 *
 * `@atproto/identity` maps every non-2xx `did:web` response to `null`, which
 * later becomes `DidNotFoundError`. That makes an outage or rate limit look
 * like permanent missing identity material. This wrapper keeps the existing
 * resolver and cache for every other DID method, while using a status-aware
 * resolver for `did:web` commit keys.
 */
export function createCommitKeyResolver(
  source: CommitKeyResolverSource,
  options: CommitKeyResolverOptions = {},
): CommitKeyResolver {
  const didWebResolver = new StatusPreservingDidWebResolver(
    options.timeoutMs ?? DEFAULT_DID_WEB_TIMEOUT_MS,
    source.cache,
    options.fetch ?? globalThis.fetch,
  )

  return {
    resolveAtprotoKey: (did, forceRefresh = false) =>
      did.startsWith('did:web:')
        ? didWebResolver.resolveAtprotoKey(did, forceRefresh)
        : source.resolveAtprotoKey(did, forceRefresh),
  }
}

class DidWebHttpError extends Error {
  readonly status: number

  constructor(did: string, status: number) {
    super(`DID web resolution failed for ${did} with HTTP ${status}`)
    this.name = 'DidWebHttpError'
    this.status = status
  }
}

class StatusPreservingDidWebResolver extends DidWebResolver {
  constructor(
    timeoutMs: number,
    cache: DidCache | undefined,
    private readonly fetch: typeof globalThis.fetch,
  ) {
    super(timeoutMs, cache)
  }

  override async resolveNoCheck(did: string): Promise<unknown> {
    const url = didWebDocumentUrl(did)
    const abortController = new AbortController()
    const timer = setTimeout(() => abortController.abort(), this.timeout)

    try {
      const response = await this.fetch(url, {
        signal: abortController.signal,
        redirect: 'error',
        headers: { accept: 'application/did+ld+json,application/json' },
      })
      if (response.status === 404) return null
      if (!response.ok) throw new DidWebHttpError(did, response.status)
      return await response.json()
    } finally {
      clearTimeout(timer)
      abortController.abort()
    }
  }
}

function didWebDocumentUrl(did: string): URL {
  const parsedId = did.split(':').slice(2).join(':')
  const parts = parsedId.split(':').map(decodeURIComponent)
  if (parts.length < 1 || parts[0] === '') {
    throw new PoorlyFormattedDidError(did)
  }
  if (parts.length !== 1) {
    throw new UnsupportedDidWebPathError(did)
  }

  const url = new URL(`https://${parts[0]}${DID_WEB_DOCUMENT_PATH}`)
  if (url.hostname === 'localhost') url.protocol = 'http:'
  return url
}
