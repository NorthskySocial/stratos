import {
  DidWebResolver,
  IdResolver,
  PoorlyFormattedDidError,
  UnsupportedDidWebPathError,
  type IdentityResolverOpts,
} from '@atproto/identity'
import { isValidHandle } from '@atproto/syntax'
import { publicFetch } from './public-fetch.js'

export function didWebDocumentUrl(did: string): URL {
  if (!did.startsWith('did:web:')) throw new PoorlyFormattedDidError(did)
  const parts = did.slice('did:web:'.length).split(':')
  if (!parts[0]) throw new PoorlyFormattedDidError(did)
  if (parts.length !== 1) throw new UnsupportedDidWebPathError(did)
  const authority = decodeURIComponent(parts[0])
  // Encoded delimiters must not turn the authority into a path, query, or userinfo.
  if (/[/\\?#@]/u.test(authority)) throw new PoorlyFormattedDidError(did)
  return new URL('/.well-known/did.json', `https://${authority}`)
}

class PublicDidWebResolver extends DidWebResolver {
  override async resolveNoCheck(did: string): Promise<unknown> {
    const response = await publicFetch(didWebDocumentUrl(did), {
      signal: AbortSignal.timeout(this.timeout),
      headers: { accept: 'application/did+ld+json,application/json' },
    })
    if (!response.ok) return null
    return response.json()
  }
}

export function createPublicIdResolver(
  opts: IdentityResolverOpts = {},
): IdResolver {
  return protectIdentityResolver(new IdResolver(opts))
}

interface NetworkIdentityResolver {
  handle: Pick<IdResolver['handle'], 'timeout' | 'resolveHttp'>
  did: { methods: Map<string, Pick<DidWebResolver, 'resolveNoCheck'>> }
}

/** Keep the caller's resolver and cache, including older indexer SDK instances. */
export function protectIdentityResolver<T extends NetworkIdentityResolver>(
  resolver: T,
): T {
  resolver.did.methods.set(
    'web',
    new PublicDidWebResolver(resolver.handle.timeout),
  )
  // The upstream resolver uses global fetch and follows redirects for HTTP handles.
  resolver.handle.resolveHttp = async (handle, signal) => {
    if (!isValidHandle(handle)) return undefined
    try {
      const timeout = AbortSignal.timeout(resolver.handle.timeout)
      const response = await publicFetch(
        new URL('/.well-known/atproto-did', `https://${handle}`),
        { signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
      )
      if (!response.ok) return undefined
      const did = (await response.text()).split('\n')[0].trim()
      return did.startsWith('did:') ? did : undefined
    } catch {
      // Let the caller fall back to DNS when HTTPS resolution fails.
    }
  }
  return resolver
}
