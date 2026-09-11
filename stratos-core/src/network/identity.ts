import {
  DidWebResolver,
  IdResolver,
  PoorlyFormattedDidError,
  UnsupportedDidWebPathError,
  type IdentityResolverOpts,
} from '@atproto/identity'
import { isValidHandle } from '@atproto/syntax'
import { createBoundedFetch } from './bounded-fetch.js'
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
  constructor(timeout: number) {
    super(timeout, undefined, publicFetch)
  }

  override resolveNoCheck(did: string): Promise<unknown> {
    didWebDocumentUrl(did)
    return super.resolveNoCheck(did)
  }
}

export function createPublicIdResolver(
  opts: Omit<IdentityResolverOpts, 'fetch'> = {},
): IdResolver {
  // PLC is operator-configured; DID web and HTTP handles use public-host checks below.
  const resolver = new IdResolver({ ...opts, fetch: createBoundedFetch() })
  resolver.did.methods.set(
    'web',
    new PublicDidWebResolver(resolver.handle.timeout),
  )
  // Keep HTTP handles on the well-known path even when the server redirects.
  resolver.handle.resolveHttp = async (handle, signal) => {
    if (!isValidHandle(handle)) return undefined
    try {
      const timeout = AbortSignal.timeout(resolver.handle.timeout)
      const response = await publicFetch(
        new URL('/.well-known/atproto-did', `https://${handle}`),
        { signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
      )
      if (response.ok) {
        const did = (await response.text()).split('\n')[0].trim()
        return did.startsWith('did:') ? did : undefined
      }
      await response.body?.cancel()
    } catch {
      // Let the caller fall back to DNS when HTTPS resolution fails.
    }
  }
  return resolver
}
