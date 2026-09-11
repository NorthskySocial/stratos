import {
  DidWebResolver,
  type DidCache,
  type DidResolver,
} from '@atproto/identity'
import { StratosError } from '@northskysocial/stratos-core'
import {
  createPublicFetch,
  didWebDocumentUrl,
} from '@northskysocial/stratos-core/network'

const DEFAULT_DID_WEB_TIMEOUT_MS = 3_000

export interface CommitKeyResolver {
  resolveAtprotoKey: (did: string) => Promise<string>
  refreshAtprotoKey: (did: string) => Promise<string>
}

export interface CommitKeyResolverSource extends Pick<
  DidResolver,
  'resolveAtprotoKey'
> {
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
    createPublicFetch(options.fetch),
  )

  return {
    resolveAtprotoKey: (did) =>
      did.startsWith('did:web:')
        ? didWebResolver.resolveAtprotoKey(did)
        : source.resolveAtprotoKey(did),
    refreshAtprotoKey: (did) =>
      did.startsWith('did:web:')
        ? didWebResolver.resolveAtprotoKey(did, true)
        : source.resolveAtprotoKey(did, true),
  }
}

class DidWebHttpError extends StratosError {
  readonly status: number

  constructor(did: string, status: number) {
    super(
      `DID web resolution failed for ${did} with HTTP ${status}`,
      'DidWebHttpError',
    )
    this.name = 'DidWebHttpError'
    this.status = status
  }
}

class StatusPreservingDidWebResolver extends DidWebResolver {
  constructor(
    timeoutMs: number,
    cache: DidCache | undefined,
    private readonly fetchDocument: typeof globalThis.fetch,
  ) {
    super(timeoutMs, cache, fetchDocument)
  }

  override async resolveNoCheck(did: string): Promise<unknown> {
    const url = didWebDocumentUrl(did)
    const abortController = new AbortController()
    const timer = setTimeout(() => abortController.abort(), this.timeout)

    try {
      const response = await this.fetchDocument(url, {
        signal: abortController.signal,
        redirect: 'error',
        headers: { accept: 'application/did+ld+json,application/json' },
      })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 404) return null
        throw new DidWebHttpError(did, response.status)
      }
      return await response.json()
    } finally {
      clearTimeout(timer)
      abortController.abort()
    }
  }
}
