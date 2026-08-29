import type { SpaceCredentialProof } from '../upstream/index.js'
import {
  InsecureHostOriginError,
  MalformedCursorError,
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
}

export interface ListRepoOpsOptions {
  space: string
  repo: string
  cursor?: string
  limit?: number
}

export interface RepoOpEntry {
  rev: string
  collection: string
  rkey: string
  cid: string | null
  prev: string | null
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

  constructor(opts: SpaceHostClientOptions) {
    this.hostOrigin = opts.hostOrigin
    this.credentialProof = opts.credentialProof
    this.fetchImpl = opts.fetch ?? fetch
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.allowHttpOrigins = opts.allowHttpOrigins ?? new Set()
    this.maxPageBytes = opts.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES
    this.maxRecordBytes = opts.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES
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
    )
    return decodeGetRecordResult(text, url)
  }

  private async get(
    pathname: string,
    searchParams: Record<string, string | undefined>,
    capBytes: number,
  ): Promise<{ url: string; text: string }> {
    const origin = this.assertSecureOrigin()
    const url = new URL(pathname, origin)
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) url.searchParams.set(key, value)
    }
    const htu = `${origin}${pathname}`
    const dpop = await this.credentialProof.createPresentationProof(
      'GET',
      htu,
    )

    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        headers: {
          accept: 'application/json',
          authorization: `DPoP ${this.credentialProof.credential}`,
          dpop,
        },
      })
    } catch (err) {
      throw classifyFetchError(err, url.toString())
    }

    const text = await readBodyWithCap(res, capBytes, url.toString())
    if (!res.ok) {
      throw buildRequestError(res.status, text, url.toString())
    }
    return { url: url.toString(), text }
  }

  /** https-only unless the exact origin is allowlisted; checked before any I/O. */
  private assertSecureOrigin(): string {
    const origin = new URL(this.hostOrigin).origin
    if (origin.startsWith('https://') || this.allowHttpOrigins.has(origin)) {
      return origin
    }
    throw new InsecureHostOriginError(origin)
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
      read += value.byteLength
      if (read > capBytes) {
        throw new SpaceHostResponseTooLargeError(url, capBytes)
      }
      text += decoder.decode(value, { stream: true })
    }
  } catch (err) {
    if (err instanceof SpaceHostResponseTooLargeError) throw err
    throw new SpaceHostUnreachableError(url, { cause: err })
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
    // non-JSON body — fall through to a generic request error
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function parseJsonRecord(text: string, url: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SpaceHostInvalidResponseError(
      url,
      'response was not valid JSON',
    )
  }
  if (!isRecord(parsed)) {
    throw new SpaceHostInvalidResponseError(
      url,
      'response was not a JSON object',
    )
  }
  return parsed
}

function decodeListRepoOpsResult(
  text: string,
  url: string,
): ListRepoOpsResult {
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

function decodeRepoOp(
  entry: unknown,
  index: number,
  url: string,
): RepoOpEntry {
  if (!isRecord(entry)) {
    throw new SpaceHostInvalidResponseError(
      url,
      `op at index ${index} was not an object`,
    )
  }
  const { rev, collection, rkey, cid, prev, value } = entry
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
  return {
    rev,
    collection,
    rkey,
    cid: typeof cid === 'string' ? cid : null,
    prev: typeof prev === 'string' ? prev : null,
    ...(value !== undefined ? { value } : {}),
  }
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
