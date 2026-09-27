import { isIP } from 'node:net'

export interface PrivateHostPolicy {
  origin: string
  networks: readonly { network: number; broadcast: number }[]
}

/** An operator-owned HTTPS endpoint whose private DNS answers may be used. */
export function parsePrivateHostPolicy(
  originValue: string | undefined,
  cidrValue: string | undefined,
): PrivateHostPolicy | undefined {
  const originText = originValue?.trim()
  const cidrText = cidrValue?.trim()
  if (!originText && !cidrText) return undefined
  if (!originText || !cidrText) {
    throw new Error(
      'FEEDGEN_SPACE_SYNC_PRIVATE_HOST_ORIGIN and FEEDGEN_SPACE_SYNC_PRIVATE_HOST_CIDRS must be set together',
    )
  }

  let url: URL
  try {
    url = new URL(originText)
  } catch {
    throw new Error(
      'FEEDGEN_SPACE_SYNC_PRIVATE_HOST_ORIGIN must be an HTTPS origin',
    )
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    isIP(url.hostname.replace(/^\[|\]$/g, ''))
  ) {
    throw new Error(
      'FEEDGEN_SPACE_SYNC_PRIVATE_HOST_ORIGIN must be an HTTPS DNS origin',
    )
  }

  const entries = cidrText.split(',').map((entry) => entry.trim())
  if (entries.length > 16 || entries.some((entry) => !entry)) {
    throw new Error(
      'FEEDGEN_SPACE_SYNC_PRIVATE_HOST_CIDRS must list 1 to 16 private IPv4 CIDRs',
    )
  }
  const networks = entries.map(parsePrivateNetwork)
  return { origin: url.origin, networks }
}

export function isPrivateHostAddress(
  address: string,
  policy: PrivateHostPolicy,
): boolean {
  if (isIP(address) !== 4) return false
  const value = ipv4ToInteger(address)
  return policy.networks.some(
    ({ network, broadcast }) => value > network && value < broadcast,
  )
}

function parsePrivateNetwork(value: string): {
  network: number
  broadcast: number
} {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value)
  const address = match?.[1]
  const prefix = Number(match?.[2])
  if (!address || isIP(address) !== 4 || prefix < 8 || prefix > 30) {
    throw new Error(
      'FEEDGEN_SPACE_SYNC_PRIVATE_HOST_CIDRS requires private IPv4 CIDRs with usable hosts',
    )
  }
  const network = ipv4ToInteger(address)
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  const broadcast = (network | (~mask >>> 0)) >>> 0
  if (
    (network & mask) >>> 0 !== network ||
    !isPrivateIpv4(network) ||
    !isPrivateIpv4(broadcast)
  ) {
    throw new Error(
      'FEEDGEN_SPACE_SYNC_PRIVATE_HOST_CIDRS must contain only aligned private IPv4 networks',
    )
  }
  return { network, broadcast }
}

function ipv4ToInteger(address: string): number {
  return (
    address
      .split('.')
      .map(Number)
      .reduce((value, octet) => value * 256 + octet, 0) >>> 0
  )
}

function isPrivateIpv4(address: number): boolean {
  const first = address >>> 24
  const second = (address >>> 16) & 0xff
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  )
}
