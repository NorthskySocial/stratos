import { lookup } from 'node:dns'
import { isIP, type LookupFunction } from 'node:net'
import ipaddr from 'ipaddr.js'
import { Agent, fetch as undiciFetch } from 'undici'
import { StratosError } from '../shared/errors.js'

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  const parsed = ipaddr.parse(address)
  // Only global IPv6 unicast: exclude site-local and IPv4 transition ranges too.
  if (
    parsed instanceof ipaddr.IPv6 &&
    !parsed.match(ipaddr.IPv6.parse('2000::'), 3)
  )
    return false
  return parsed.range() === 'unicast'
}

export const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, '')
      return
    }
    if (
      addresses.length === 0 ||
      addresses.some(({ address }) => !isPublicAddress(address))
    ) {
      callback(
        new StratosError(
          'Outbound destination is not a public address',
          'UnsafeOutboundAddress',
        ),
        '',
      )
      return
    }
    if (options.all) callback(null, addresses)
    else callback(null, addresses[0].address, addresses[0].family)
  })
}

/** Check DNS answers in the socket lookup, so the connection uses the checked address. */
export function createPublicFetch(
  baseFetch: typeof fetch = fetchWithDispatcher,
): typeof fetch {
  const dispatcher = new Agent({ connect: { lookup: publicLookup } })
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new StratosError(
        'Outbound requests require an HTTPS URL without credentials',
        'UnsafeOutboundUrl',
      )
    }
    const hostname = url.hostname.startsWith('[')
      ? url.hostname.slice(1, -1)
      : url.hostname
    if (isIP(hostname) && !isPublicAddress(hostname)) {
      throw new StratosError(
        'Outbound destination is not a public address',
        'UnsafeOutboundAddress',
      )
    }
    // Reject even same-origin redirects: they can escape an allowed XRPC or well-known path.
    const requestInit = {
      ...init,
      redirect: 'error' as const,
      dispatcher,
    }
    // Node and the indexer's Deno types carry different Undici dispatcher declarations.
    return baseFetch(input, requestInit as unknown as RequestInit)
  }
}

const fetchWithDispatcher: typeof fetch = (input, init) => {
  if ('Deno' in globalThis) {
    // Deno's native fetch silently ignores `dispatcher`; use the Node transport explicitly.
    const request = new Request(input, init)
    return undiciFetch(request.url, {
      ...init,
      method: request.method,
      headers: [...request.headers],
      body: request.body,
      signal: request.signal,
      redirect: request.redirect,
      duplex: 'half',
    } as unknown as Parameters<
      typeof undiciFetch
    >[1]) as unknown as Promise<Response>
  }
  return globalThis.fetch(input, init)
}

export const publicFetch = createPublicFetch()
