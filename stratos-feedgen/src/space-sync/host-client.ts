import { lookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'
import { Agent, type Dispatcher } from 'undici'
import {
  DEFAULT_SPACE_SYNC_PAGE_LIMIT,
  DEFAULT_SPACE_SYNC_MAX_RECORD_BYTES,
  DEFAULT_SPACE_SYNC_REQUEST_TIMEOUT_MS,
} from '../config.js'
import type { SpaceCredentialProof } from '../upstream/index.js'
import {
  InsecureHostOriginError,
  InvalidHostOriginError,
  MalformedCursorError,
  PrivateHostOriginError,
  RepoNotFoundError,
  SpaceHostClientError,
  SpaceHostInvalidResponseError,
  SpaceHostRedirectError,
  SpaceHostRequestError,
  SpaceHostResponseTooLargeError,
  SpaceHostTimeoutError,
  SpaceHostUnreachableError,
  SpaceNotFoundError,
} from './errors.js'

const ERROR_BODY_CAP_BYTES = 4_096
const JSON_ENVELOPE_BYTES = 16_384
const OP_METADATA_BYTES = 2_048
const DEFAULT_MAX_PAGE_BYTES = getRepoOpsResponseByteLimit(
  DEFAULT_SPACE_SYNC_PAGE_LIMIT,
  DEFAULT_SPACE_SYNC_MAX_RECORD_BYTES,
)
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
   * Literal loopback origins allowed over plain http, matched by exact
   * `new URL(...).origin`. Empty by default. A credential never crosses a
   * remote plain-http connection.
   */
  allowHttpOrigins?: ReadonlySet<string>
  /** Byte cap for a `listRepoOps` page response body. */
  maxPageBytes?: number
  /** Byte cap for the decoded record value; response framing gets bounded headroom. */
  maxRecordBytes?: number
  /** Injectable DNS resolver. The request signal bounds callers even when the resolver ignores it. */
  resolveHost?: (
    hostname: string,
    signal?: AbortSignal,
  ) => Promise<readonly string[]>
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
  /** Opaque signed-commit envelope verified on terminal pages by the sync runner. */
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
 * time-bounded, refuses redirects, is https-only except for configured
 * literal loopback origins, and caps the response body it will read.
 */
export class SpaceHostClient {
  private readonly hostOrigin: string
  private readonly credentialProof: SpaceCredentialProof
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number
  private readonly allowHttpOrigins: ReadonlySet<string>
  private readonly maxPageBytes: number
  private readonly maxRecordBytes: number
  private readonly resolveHost: (
    hostname: string,
    signal?: AbortSignal,
  ) => Promise<readonly string[]>

  constructor(opts: SpaceHostClientOptions) {
    this.hostOrigin = opts.hostOrigin
    this.credentialProof = opts.credentialProof
    this.fetchImpl = opts.fetch ?? fetch
    this.requestTimeoutMs =
      opts.requestTimeoutMs ?? DEFAULT_SPACE_SYNC_REQUEST_TIMEOUT_MS
    this.allowHttpOrigins = opts.allowHttpOrigins ?? new Set()
    this.maxPageBytes = opts.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES
    this.maxRecordBytes = getRecordResponseByteLimit(
      opts.maxRecordBytes ?? DEFAULT_SPACE_SYNC_MAX_RECORD_BYTES,
    )
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
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs)
    const requestSignal = signal
      ? AbortSignal.any([timeoutSignal, signal])
      : timeoutSignal
    let validated: ValidatedOrigin
    try {
      validated = await this.assertSecureOrigin(requestSignal)
    } catch (err) {
      if (signal?.aborted) throw err
      if (err instanceof SpaceHostClientError) throw err
      throw classifyFetchError(err, this.hostOrigin)
    }

    const { origin } = validated
    const url = new URL(pathname, origin)
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) url.searchParams.set(key, value)
    }
    const htu = `${origin}${pathname}`
    const dpop = await this.credentialProof.createPresentationProof('GET', htu)

    const dispatcher = validated.addresses
      ? createPinnedDispatcher(validated.addresses)
      : undefined
    let res: Response
    try {
      const requestInit: RequestInit & { dispatcher?: Dispatcher } = {
        method: 'GET',
        redirect: 'error',
        signal: requestSignal,
        headers: {
          accept: 'application/json',
          authorization: `DPoP ${this.credentialProof.credential}`,
          dpop,
        },
        ...(dispatcher ? { dispatcher } : {}),
      }
      res = await this.fetchImpl(url, requestInit as RequestInit)

      const text = res.ok
        ? await readSuccessfulBody(res, capBytes, url.toString(), signal)
        : await readTruncatedErrorBody(res, url.toString(), signal)
      if (!res.ok) {
        throw buildRequestError(res.status, text, url.toString())
      }
      return { url: url.toString(), text }
    } catch (err) {
      if (signal?.aborted) throw err
      if (err instanceof SpaceHostClientError) throw err
      throw classifyFetchError(err, url.toString())
    } finally {
      await dispatcher?.destroy().catch(() => {})
    }
  }

  /** Validate and pin the addresses before any HTTPS request. */
  private async assertSecureOrigin(
    signal: AbortSignal,
  ): Promise<ValidatedOrigin> {
    let url: URL
    try {
      url = new URL(this.hostOrigin)
    } catch (err) {
      throw new InvalidHostOriginError(this.hostOrigin, { cause: err })
    }
    const origin = url.origin
    if (
      url.protocol === 'http:' &&
      this.allowHttpOrigins.has(origin) &&
      isLoopbackHttpHostname(url.hostname)
    ) {
      return { origin }
    }
    if (url.protocol !== 'https:') {
      throw new InsecureHostOriginError(origin)
    }

    const hostname = stripIpv6Brackets(url.hostname)
    const addresses = isIP(hostname)
      ? [hostname]
      : await abortable(this.resolveHost(hostname, signal), signal)
    if (addresses.length === 0) {
      throw new SpaceHostUnreachableError(origin, {
        cause: new Error('the host did not resolve to an address'),
      })
    }
    for (const address of addresses) {
      if (isPrivateAddress(address)) {
        throw new PrivateHostOriginError(origin, address)
      }
    }
    return { origin, addresses }
  }
}

/**
 * Bound a page body from the configured record/page limits while leaving
 * room for each operation's revision/path/CID fields and the JSON envelope.
 */
export function getRepoOpsResponseByteLimit(
  pageLimit: number,
  maxRecordBytes: number,
): number {
  return boundedByteLimit(
    JSON_ENVELOPE_BYTES + pageLimit * (maxRecordBytes + OP_METADATA_BYTES),
  )
}

/** Leave bounded room for `{uri,cid,value}` around a near-limit value. */
export function getRecordResponseByteLimit(maxRecordBytes: number): number {
  return boundedByteLimit(maxRecordBytes + JSON_ENVELOPE_BYTES)
}

function boundedByteLimit(value: number): number {
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER
}

interface ValidatedOrigin {
  origin: string
  /** Absent only for an exact plain-HTTP development exception. */
  addresses?: readonly string[]
}

function createPinnedDispatcher(addresses: readonly string[]): Dispatcher {
  return new Agent({ connect: { lookup: createPinnedLookup(addresses) } })
}

export function createPinnedLookup(
  addresses: readonly string[],
): LookupFunction {
  const pinned = addresses.map((address) => ({
    address,
    family: isIP(address),
  }))
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    const requestedFamily =
      options.family === 'IPv4'
        ? 4
        : options.family === 'IPv6'
          ? 6
          : options.family
    const compatible = requestedFamily
      ? pinned.filter(({ family }) => family === requestedFamily)
      : pinned
    if (compatible.length === 0) {
      callback(new Error('the validated host has no compatible address'), '')
      return
    }
    if (options.all) {
      callback(null, compatible)
      return
    }
    callback(null, compatible[0].address, compatible[0].family)
  }
  return pinnedLookup
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(toError(signal.reason))
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(toError(signal.reason))
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(toError(err))
      },
    )
  })
}

function toError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error('operation rejected with a non-Error reason', { cause: reason })
}

/**
 * Reads a response body up to `capBytes`, decoding as it goes rather than
 * trusting `content-length` — a foreign host can send any header it likes.
 * Cancels the stream as soon as the cap is crossed.
 */
async function readSuccessfulBody(
  res: Response,
  capBytes: number,
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await readBodyPrefix(res, capBytes, url, signal)
  if (!result.complete) {
    throw new SpaceHostResponseTooLargeError(url, capBytes)
  }
  return result.text
}

async function readTruncatedErrorBody(
  res: Response,
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  return (await readBodyPrefix(res, ERROR_BODY_CAP_BYTES, url, signal)).text
}

interface BodyPrefix {
  text: string
  complete: boolean
}

async function readBodyPrefix(
  res: Response,
  capBytes: number,
  url: string,
  signal?: AbortSignal,
): Promise<BodyPrefix> {
  const body = res.body
  if (!body) return { text: '', complete: true }

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
        if (remaining > 0) {
          text += decoder.decode(value.subarray(0, remaining), { stream: true })
        }
        return { text: text + decoder.decode(), complete: false }
      }
      read += value.byteLength
      text += decoder.decode(value, { stream: true })
    }
  } catch (err) {
    if (signal?.aborted) throw err
    throw classifyFetchError(err, url)
  } finally {
    await reader.cancel().catch(() => {})
  }
  return { text: text + decoder.decode(), complete: true }
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

async function resolveHost(
  hostname: string,
  _signal?: AbortSignal,
): Promise<readonly string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  return addresses.map(({ address }) => address)
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
}

function isLoopbackHttpHostname(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname)
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    (isIP(normalized) === 4 && normalized.startsWith('127.'))
  )
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
