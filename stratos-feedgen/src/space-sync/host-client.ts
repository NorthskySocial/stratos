import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { SpaceCredentialProof } from '../upstream/index.js'
import {
  InsecureHostOriginError,
  InvalidHostOriginError,
  MalformedCursorError,
  PrivateHostOriginError,
  RepoNotFoundError,
  SpaceHostInvalidResponseError,
  SpaceHostRedirectError,
  SpaceHostRequestError,
  SpaceHostResponseTooLargeError,
  SpaceHostTimeoutError,
  SpaceHostUnreachableError,
  SpaceNotFoundError,
} from './errors.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
/** Generous for a full page of ops; WP6 makes this configurable. */
const DEFAULT_MAX_PAGE_BYTES = 1_048_576
/** Matches `FEEDGEN_SPACE_SYNC_MAX_RECORD_BYTES`'s planned default (WP6). */
const DEFAULT_MAX_RECORD_BYTES = 65_536
const ERROR_BODY_CAP_BYTES = 4_096
const PRIVATE_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 0x00ffffff],
  [0x0a000000, 0x0affffff],
  [0x64400000, 0x647fffff],
  [0x7f000000, 0x7fffffff],
  [0xa9fe0000, 0xa9feffff],
  [0xac100000, 0xac1fffff],
  [0xc0a80000, 0xc0a8ffff],
  [0xe0000000, 0xffffffff],
]

export interface SpaceHostClientOptions {
  /** Origin (scheme + host [+ port]) this client sends every request to. */
  hostOrigin: string
  /** Presents the space credential minted for the space being synced. */
  credentialProof: SpaceCredentialProof
  /** Injectable fetch implementation (test seam). */
  fetch?: typeof fetch
  /** Abort a request that runs longer than this. */
  requestTimeoutMs?: number
  /**
   * Origins allowed over plain http despite not being https, matched by
   * exact `new URL(...).origin`. Empty by default — a foreign host is
   * untrusted, so plain http takes an explicit, per-origin opt-in.
   */
  allowHttpOrigins?: ReadonlySet<string>
  /** Byte cap for a `listRepoOps` page response body. */
  maxPageBytes?: number
  /** Byte cap for a `getRecord` response body. */
  maxRecordBytes?: number
  /** Injectable DNS resolver. */
  resolveHost?: (hostname: string) => Promise<readonly string[]>
}

export interface ListRepoOpsOptions {
  space: string
  repo: string
  cursor?: string
  limit?: number
  /** Aborts the request early, combined with the per-request timeout. */
  signal?: AbortSignal
}

export interface RepoOpEntry {
  rev: string
  collection: string
  rkey: string
  cid: string | null
  value?: unknown
}

export interface ListRepoOpsResult {
  ops: RepoOpEntry[]
  /** Opaque signed-commit envelope. Decoded and verified in a later work package. */
  commit?: Record<string, unknown>
  cursor?: string
}

export interface GetRecordOptions {
  space: string
  repo: string
  collection: string
  rkey: string
  /** Aborts the request early, combined with the per-request timeout. */
  signal?: AbortSignal
}

export interface GetRecordResult {
  uri: string
  cid: string
  value: unknown
}

/**
 * Reads a member's repo from an arbitrary host origin, discovered from that
 * member's own DID document. That host is an untrusted network peer — its
 * operator controls it for their own DID — so every request here is
 * time-bounded, refuses redirects, is https-only unless explicitly
 * allowlisted, and caps the response body it will read.
 */
export class SpaceHostClient {
  private readonly hostOrigin: string
  private readonly credentialProof: SpaceCredentialProof
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number
  private readonly allowHttpOrigins: ReadonlySet<string>
  private readonly maxPageBytes: number
  private readonly maxRecordBytes: number
  private readonly resolveHost: (hostname: string) => Promise<readonly string[]>

  constructor(opts: SpaceHostClientOptions) {
    this.hostOrigin = opts.hostOrigin
    this.credentialProof = opts.credentialProof
    this.fetchImpl = opts.fetch ?? fetch
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.allowHttpOrigins = opts.allowHttpOrigins ?? new Set()
    this.maxPageBytes = opts.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES
    this.maxRecordBytes = opts.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES
    this.resolveHost = opts.resolveHost ?? resolveHost
  }

  async listRepoOps(opts: ListRepoOpsOptions): Promise<ListRepoOpsResult> {
    const { url, text } = await this.get(
      '/xrpc/com.atproto.space.listRepoOps',
      {
        space: opts.space,
        repo: opts.repo,
        cursor: opts.cursor,
        limit: opts.limit === undefined ? undefined : String(opts.limit),
      },
      this.maxPageBytes,
      opts.signal,
    )
    return decodeListRepoOpsResult(text, url)
  }

  async getRecord(opts: GetRecordOptions): Promise<GetRecordResult> {
    const { url, text } = await this.get(
      '/xrpc/com.atproto.space.getRecord',
      {
        space: opts.space,
        repo: opts.repo,
        collection: opts.collection,
        rkey: opts.rkey,
      },
      this.maxRecordBytes,
      opts.signal,
    )
    return decodeGetRecordResult(text, url)
  }

  private async get(
    pathname: string,
    searchParams: Record<string, string | undefined>,
    capBytes: number,
    signal?: AbortSignal,
  ): Promise<{ url: string; text: string }> {
    const origin = await this.assertSecureOrigin()
    const url = new URL(pathname, origin)
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) url.searchParams.set(key, value)
    }
    const htu = `${origin}${pathname}`
    const dpop = await this.credentialProof.createPresentationProof('GET', htu)

    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs)
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([timeoutSignal, signal])
          : timeoutSignal,
        headers: {
          accept: 'application/json',
          authorization: `DPoP ${this.credentialProof.credential}`,
          dpop,
        },
      })
    } catch (err) {
      if (signal?.aborted) throw err
      throw classifyFetchError(err, url.toString())
    }

    const text = await readBodyWithCap(
      res,
      res.ok ? capBytes : ERROR_BODY_CAP_BYTES,
      url.toString(),
      !res.ok,
      signal,
    )
    if (!res.ok) {
      throw buildRequestError(res.status, text, url.toString())
    }
    return { url: url.toString(), text }
  }

  /** Validate the scheme and resolved addresses before any request. */
  private async assertSecureOrigin(): Promise<string> {
    let url: URL
    try {
      url = new URL(this.hostOrigin)
    } catch (err) {
      throw new InvalidHostOriginError(this.hostOrigin, { cause: err })
    }
    const origin = url.origin
    if (this.allowHttpOrigins.has(origin)) {
      return origin
    }
    if (url.protocol !== 'https:') {
      throw new InsecureHostOriginError(origin)
    }

    const hostname = stripIpv6Brackets(url.hostname)
    let addresses: readonly string[]
    try {
      addresses = isIP(hostname) ? [hostname] : await this.resolveHost(hostname)
    } catch (err) {
      throw new SpaceHostUnreachableError(origin, { cause: err })
    }
    if (addresses.length === 0) {
      throw new SpaceHostUnreachableError(origin, {
        cause: new Error('the host did not resolve to an address'),
      })
    }
    // DNS can change after this check. The transport must add address pinning
    // before this check can prevent rebinding during the request.
    for (const address of addresses) {
      if (isPrivateAddress(address)) {
        throw new PrivateHostOriginError(origin, address)
      }
    }
    return origin
  }
}

/**
 * Reads a response body up to `capBytes`, decoding as it goes rather than
 * trusting `content-length` — a foreign host can send any header it likes.
 * Cancels the stream as soon as the cap is crossed.
 */
async function readBodyWithCap(
  res: Response,
  capBytes: number,
  url: string,
  truncate = false,
  signal?: AbortSignal,
): Promise<string> {
  const body = res.body
  if (!body) return ''

  const decoder = new TextDecoder()
  const reader = body.getReader()
  let read = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = capBytes - read
      if (value.byteLength > remaining) {
        if (truncate && remaining > 0) {
          text += decoder.decode(value.subarray(0, remaining), { stream: true })
        }
        if (truncate) break
        throw new SpaceHostResponseTooLargeError(url, capBytes)
      }
      read += value.byteLength
      text += decoder.decode(value, { stream: true })
    }
  } catch (err) {
    if (err instanceof SpaceHostResponseTooLargeError) throw err
    if (signal?.aborted) throw err
    throw classifyFetchError(err, url)
  } finally {
    await reader.cancel().catch(() => {})
  }
  return text + decoder.decode()
}

/**
 * `redirect: 'error'` and connection failure both reject `fetch` with a
 * generic `TypeError: fetch failed`; only `cause.message` tells them apart.
 * `AbortSignal.timeout` instead rejects with a `TimeoutError` DOMException.
 */
function classifyFetchError(err: unknown, url: string): Error {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new SpaceHostTimeoutError(url)
  }
  if (err instanceof Error && isUnexpectedRedirect(err)) {
    return new SpaceHostRedirectError(url)
  }
  return new SpaceHostUnreachableError(url, { cause: err })
}

function isUnexpectedRedirect(err: Error): boolean {
  return (
    err.cause instanceof Error && err.cause.message === 'unexpected redirect'
  )
}

function buildRequestError(
  status: number,
  body: string,
  url: string,
): SpaceHostRequestError {
  const errorCode = parseErrorCode(body)
  switch (errorCode) {
    case 'MalformedCursor':
      return new MalformedCursorError({ status, body, url })
    case 'RepoNotFound':
      return new RepoNotFoundError({ status, body, url })
    case 'SpaceNotFound':
      return new SpaceNotFoundError({ status, body, url })
    case undefined:
    default:
      return new SpaceHostRequestError({ status, body, url, errorCode })
  }
}

function parseErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    if (isRecord(parsed) && typeof parsed.error === 'string') {
      return parsed.error
    }
  } catch {
    const match = /"error"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(body)
    if (match) {
      try {
        return JSON.parse(`"${match[1]}"`) as string
      } catch {
        // Continue with a generic request error.
      }
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonRecord(text: string, url: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SpaceHostInvalidResponseError(url, 'response was not valid JSON')
  }
  if (!isRecord(parsed)) {
    throw new SpaceHostInvalidResponseError(
      url,
      'response was not a JSON object',
    )
  }
  return parsed
}

function decodeListRepoOpsResult(text: string, url: string): ListRepoOpsResult {
  const raw = parseJsonRecord(text, url)
  if (!Array.isArray(raw.ops)) {
    throw new SpaceHostInvalidResponseError(
      url,
      'response was missing an "ops" array',
    )
  }
  return {
    ops: raw.ops.map((entry, index) => decodeRepoOp(entry, index, url)),
    commit: isRecord(raw.commit) ? raw.commit : undefined,
    cursor: typeof raw.cursor === 'string' ? raw.cursor : undefined,
  }
}

function decodeRepoOp(entry: unknown, index: number, url: string): RepoOpEntry {
  if (!isRecord(entry)) {
    throw new SpaceHostInvalidResponseError(
      url,
      `op at index ${index} was not an object`,
    )
  }
  const { rev, collection, rkey, cid, value } = entry
  if (
    typeof rev !== 'string' ||
    typeof collection !== 'string' ||
    typeof rkey !== 'string'
  ) {
    throw new SpaceHostInvalidResponseError(
      url,
      `op at index ${index} was missing a required field`,
    )
  }
  if (cid !== null && typeof cid !== 'string') {
    throw new SpaceHostInvalidResponseError(
      url,
      `op at index ${index} had an invalid "cid"`,
    )
  }
  return {
    rev,
    collection,
    rkey,
    cid,
    ...(value !== undefined ? { value } : {}),
  }
}

async function resolveHost(hostname: string): Promise<readonly string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  return addresses.map(({ address }) => address)
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase()
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4[1])
  const mappedIpv4Hex = normalized.match(
    /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u,
  )
  if (mappedIpv4Hex) {
    const high = Number.parseInt(mappedIpv4Hex[1], 16)
    const low = Number.parseInt(mappedIpv4Hex[2], 16)
    return isPrivateIpv4(
      `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`,
    )
  }
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized)
  if (isIP(normalized) !== 6) return true

  const first = Number.parseInt(normalized.split(':', 1)[0] || '0', 16)
  return (
    normalized === '::' ||
    normalized === '::1' ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00
  )
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => part < 0 || part > 255)) {
    return true
  }
  const value =
    (parts[0] * 0x1000000 +
      parts[1] * 0x10000 +
      parts[2] * 0x100 +
      parts[3]) >>>
    0
  return PRIVATE_IPV4_RANGES.some(
    ([start, end]) => value >= start && value <= end,
  )
}

function decodeGetRecordResult(text: string, url: string): GetRecordResult {
  const raw = parseJsonRecord(text, url)
  if (typeof raw.uri !== 'string' || typeof raw.cid !== 'string') {
    throw new SpaceHostInvalidResponseError(
      url,
      'response was missing "uri" or "cid"',
    )
  }
  return { uri: raw.uri, cid: raw.cid, value: raw.value }
}
