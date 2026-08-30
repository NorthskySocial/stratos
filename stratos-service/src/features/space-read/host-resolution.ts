import { IdResolver } from '@atproto/identity'
import type {
  DidPdsReader,
  HostOverrideReader,
  RepoHostResolverDeps,
} from '@northskysocial/stratos-core'

/**
 * Reports a member's own `repoHost` (from their enrollment row) as Stratos's
 * authority-recorded override. `repoHost` is written on enrolment and kept
 * current on a PDS move, so it is already the answer to "does Stratos know a
 * host for this member that overrides their DID document" -- no separate
 * override table is needed.
 */
export class EnrollmentHostOverrideReader implements HostOverrideReader {
  constructor(private readonly repoHost: string | undefined) {}

  async get(): Promise<string | undefined> {
    return this.repoHost
  }
}

/**
 * Resolves a member's `#atproto_pds` service endpoint from their DID
 * document. Mirrors `PdsTokenVerifier.getPdsEndpointFromDid`
 * (`infra/auth/introspection-client.ts`); duplicated rather than shared
 * because that reader is scoped to OAuth issuer verification, a different
 * concern that happens to resolve the same field.
 */
export class DidDocumentPdsReader implements DidPdsReader {
  constructor(private readonly idResolver: IdResolver) {}

  async getPdsEndpoint(memberDid: string): Promise<string | undefined> {
    // A did:web resolution fetches `https://{host}/.well-known/did.json`
    // server-side, and the host comes from the member's own DID. Refuse a
    // host in private or local address space before any fetch (SSRF). This
    // does not defend against DNS rebinding; a deployment must also isolate
    // egress at the network level.
    if (memberDid.startsWith(DID_WEB_PREFIX)) {
      const host = didWebHostname(memberDid)
      if (!host || isPrivateOrLocalHost(host)) return undefined
    }
    try {
      const didDoc = await this.idResolver.did.resolve(memberDid)
      if (!didDoc) return undefined

      for (const service of didDoc.service ?? []) {
        const isPdsService =
          service.id === '#atproto_pds' ||
          service.id === `${memberDid}#atproto_pds`
        if (isPdsService && typeof service.serviceEndpoint === 'string') {
          return service.serviceEndpoint
        }
      }
      return undefined
    } catch {
      return undefined
    }
  }
}

const DID_WEB_PREFIX = 'did:web:'

/**
 * Extract the hostname a did:web resolves against. The first colon-separated
 * segment after the prefix is the percent-encoded authority; it may carry a
 * port. Returns `undefined` when the authority does not parse.
 */
export function didWebHostname(did: string): string | undefined {
  const [encodedAuthority] = did.slice(DID_WEB_PREFIX.length).split(':')
  if (!encodedAuthority) return undefined
  try {
    const url = new URL(`https://${decodeURIComponent(encodedAuthority)}`)
    // WHATWG URL keeps brackets on an IPv6 hostname; strip them.
    return url.hostname.replace(/^\[|\]$/g, '')
  } catch {
    return undefined
  }
}

/**
 * True for a hostname in loopback, private, link-local, or local-only DNS
 * space -- the destinations a server-side fetch must never reach for a
 * caller-chosen host.
 */
export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase()

  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true
    if (/^f[cd]/.test(host)) return true // fc00::/7 unique local
    if (/^fe[89ab]/.test(host)) return true // fe80::/10 link local
    if (host.startsWith('::ffff:')) {
      // An IPv4-mapped address answers for its embedded IPv4.
      return isPrivateOrLocalHost(host.slice('::ffff:'.length))
    }
    return false
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }

  return (
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    // A single-label name, `localhost` included, only resolves on an
    // internal search domain.
    !host.includes('.')
  )
}

/**
 * Builds the {@link RepoHostResolverDeps} `resolveRepoHost` needs for one
 * member. `repoHost` comes from that member's own enrollment row.
 */
export function createRepoHostResolverDeps(
  idResolver: IdResolver,
  repoHost: string | undefined,
): RepoHostResolverDeps {
  return {
    overrides: new EnrollmentHostOverrideReader(repoHost),
    dids: new DidDocumentPdsReader(idResolver),
  }
}
