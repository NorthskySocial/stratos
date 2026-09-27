import { lookup } from 'node:dns'
import { isIP, type LookupFunction } from 'node:net'
import ipaddr from 'ipaddr.js'
import { Agent, fetch as undiciFetch } from 'undici'
import { StratosError } from '../shared/errors.js'
import { createBoundedFetch } from './bounded-fetch.js'

export interface TrustedOriginPolicy {
  origin: string
  privateCidrs: readonly string[]
}

interface ParsedTrustedOrigin {
  origin: string
  hostname: string
  privateCidrs: ReturnType<typeof ipaddr.parseCIDR>[]
}

const PRIVATE_NETWORKS = [
  ipaddr.parseCIDR('10.0.0.0/8'),
  ipaddr.parseCIDR('172.16.0.0/12'),
  ipaddr.parseCIDR('192.168.0.0/16'),
  ipaddr.parseCIDR('fc00::/7'),
]

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

function parseTrustedOrigin(policy: TrustedOriginPolicy): ParsedTrustedOrigin {
  const url = new URL(policy.origin)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    isIP(url.hostname)
  ) {
    throw new Error('Trusted origin must be an HTTPS DNS origin')
  }
  const cidrs = policy.privateCidrs.map((value) => ipaddr.parseCIDR(value))
  if (
    cidrs.some(
      ([network, prefix]) =>
        !PRIVATE_NETWORKS.some(
          ([privateNetwork, privatePrefix]) =>
            network.kind() === privateNetwork.kind() &&
            prefix >= privatePrefix &&
            network.match(privateNetwork, privatePrefix),
        ),
    )
  ) {
    throw new Error('Trusted origin CIDRs must be private')
  }
  return { origin: url.origin, hostname: url.hostname, privateCidrs: cidrs }
}

function isAllowedPrivateAddress(
  address: string,
  policy: ParsedTrustedOrigin,
): boolean {
  if (!isIP(address)) return false
  const parsed = ipaddr.parse(address)
  return policy.privateCidrs.some(([network, prefix]) => {
    if (parsed.kind() !== network.kind() || !parsed.match(network, prefix)) {
      return false
    }
    if (parsed instanceof ipaddr.IPv4 && prefix <= 30) {
      const bits = parsed
        .toByteArray()
        .reduce((value, byte) => value * 256 + byte, 0)
      const mask = 2 ** (32 - prefix) - 1
      if (bits % (mask + 1) === 0 || bits % (mask + 1) === mask) {
        return false
      }
    }
    return true
  })
}

export function createCheckedLookup(
  policy?: TrustedOriginPolicy,
): LookupFunction {
  const parsedPolicy = policy ? parseTrustedOrigin(policy) : undefined
  return (hostname, options, callback) => {
    lookup(
      hostname,
      { ...options, family: 0, all: true },
      (error, addresses) => {
        if (error) {
          callback(error, '')
          return
        }
        const allPublic =
          addresses.length > 0 &&
          addresses.every(({ address }) => isPublicAddress(address))
        const allAllowedPrivate =
          parsedPolicy?.hostname === hostname &&
          addresses.length > 0 &&
          addresses.every(({ address }) =>
            isAllowedPrivateAddress(address, parsedPolicy),
          )
        if (!allPublic && !allAllowedPrivate) {
          callback(
            new StratosError(
              'Outbound destination is not a public address',
              'UnsafeOutboundAddress',
            ),
            '',
          )
          return
        }
        const selected = options.family
          ? addresses.filter(({ family }) => family === options.family)
          : addresses
        if (selected.length === 0) {
          callback(
            new StratosError(
              'No address in the requested family',
              'UnsafeOutboundAddress',
            ),
            '',
          )
          return
        }
        if (options.all) callback(null, selected)
        else callback(null, selected[0].address, selected[0].family)
      },
    )
  }
}

export const publicLookup: LookupFunction = createCheckedLookup()

/** Validate DNS answers in the socket lookup, then connect to that answer. */
export function createPublicFetch(
  baseFetch: typeof fetch = fetchWithDispatcher,
  trustedOrigins: readonly TrustedOriginPolicy[] = [],
): typeof fetch {
  const publicDispatcher = new Agent({ connect: { lookup: publicLookup } })
  const privateDispatchers = new Map(
    trustedOrigins.map((entry) => {
      const policy = parseTrustedOrigin(entry)
      return [
        policy.origin,
        new Agent({ connect: { lookup: createCheckedLookup(entry) } }),
      ] as const
    }),
  )
  const boundedFetch = createBoundedFetch(baseFetch)
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
    // Redirects can escape both the permitted origin and the requested path.
    const requestInit = {
      ...init,
      redirect: 'error' as const,
      dispatcher: privateDispatchers.get(url.origin) ?? publicDispatcher,
    }
    return boundedFetch(input, requestInit as unknown as RequestInit)
  }
}

const fetchWithDispatcher: typeof fetch = (input, init) => {
  if ('Deno' in globalThis) {
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
