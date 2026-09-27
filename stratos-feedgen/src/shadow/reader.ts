import {
  compareShadowFeedDecisions,
  type ShadowFeedDecision,
  type ShadowMismatchReason,
} from './feed-comparator.js'

const SHADOW_ENDPOINT = '/xrpc/zone.stratos.feedgen.getFeed'
const MAX_RESPONSE_BYTES = 1_048_576

export interface ShadowFeedRead {
  /** Verified service-auth header. It is never logged or retained after fetch. */
  authorization: string
  feed: string
  cursor?: string
  limit: number
  primary: ShadowFeedDecision
}

/** Bounded telemetry only; no identifiers or response values are exposed. */
export interface ShadowFeedMetrics {
  recordShadowFeed: (outcome: ShadowFeedOutcome) => void
}

export type ShadowFeedOutcome =
  | 'matched'
  | 'unavailable'
  | 'dropped'
  | `mismatch_${ShadowMismatchReason}`

export interface ShadowFeedReader {
  observe: (input: ShadowFeedRead) => void
}

export interface HttpShadowFeedReaderDeps {
  baseUrl: string
  sampleRate: number
  requestTimeoutMs: number
  maxConcurrent: number
  metrics?: ShadowFeedMetrics
  fetch?: typeof globalThis.fetch
  random?: () => number
}

/**
 * A best-effort loopback observer. It is deliberately fire-and-forget: a Rust
 * reader failure, timeout, or queue-full condition cannot affect the response
 * TypeScript has already selected for the client.
 */
export class HttpShadowFeedReader implements ShadowFeedReader {
  private active = 0
  private readonly fetch: typeof globalThis.fetch
  private readonly random: () => number

  constructor(private readonly deps: HttpShadowFeedReaderDeps) {
    this.fetch = deps.fetch ?? globalThis.fetch
    this.random = deps.random ?? Math.random
  }

  observe(input: ShadowFeedRead): void {
    if (this.random() >= this.deps.sampleRate) return
    if (this.active >= this.deps.maxConcurrent) {
      this.deps.metrics?.recordShadowFeed('dropped')
      return
    }
    this.active += 1
    void this.compare(input).finally(() => {
      this.active -= 1
    })
  }

  private async compare(input: ShadowFeedRead): Promise<void> {
    try {
      const response = await this.fetch(this.requestUrl(input), {
        headers: { authorization: input.authorization },
        redirect: 'error',
        signal: AbortSignal.timeout(this.deps.requestTimeoutMs),
      })
      const shadow = await toShadowDecision(response)
      const comparison = compareShadowFeedDecisions(input.primary, shadow)
      this.deps.metrics?.recordShadowFeed(
        comparison.matched ? 'matched' : `mismatch_${comparison.reason}`,
      )
    } catch {
      this.deps.metrics?.recordShadowFeed('unavailable')
    }
  }

  private requestUrl(input: ShadowFeedRead): string {
    const url = new URL(SHADOW_ENDPOINT, this.deps.baseUrl)
    url.search = new URLSearchParams({
      feed: input.feed,
      limit: String(input.limit),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }).toString()
    return url.toString()
  }
}

async function toShadowDecision(
  response: Response,
): Promise<ShadowFeedDecision> {
  const body = await readJson(response)
  if (!isObject(body)) return invalidShadowDecision(response.status)
  if (response.status !== 200) {
    const error = xrpcErrorCode(body)
    if (!error) return invalidShadowDecision(response.status)
    return {
      status: response.status,
      error,
      postIdentifiers: [],
    }
  }
  const feed = getFeed(body)
  const cursor = getCursor(body)
  if (!feed || cursor === null) return invalidShadowDecision(response.status)
  return {
    status: response.status,
    cursor,
    postIdentifiers: feed,
  }
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('shadow response has no body')
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('shadow response exceeded byte limit')
    }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

function invalidShadowDecision(status: number): ShadowFeedDecision {
  return { status, error: 'InvalidShadowResponse', postIdentifiers: [] }
}

function xrpcErrorCode(value: Record<string, unknown>): string | undefined {
  if (typeof value['error'] !== 'string') return undefined
  return value['error'].slice(0, 64)
}

function getCursor(value: Record<string, unknown>): string | undefined | null {
  if (value['cursor'] === undefined) return undefined
  return typeof value['cursor'] === 'string' ? value['cursor'] : null
}

function getFeed(value: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(value['feed'])) return undefined
  const identifiers: string[] = []
  for (const item of value['feed']) {
    if (!isObject(item) || !isObject(item['post'])) return undefined
    const uri = item['post']['uri']
    const cid = item['post']['cid']
    if (typeof uri !== 'string' || typeof cid !== 'string') return undefined
    identifiers.push(`${uri}#${cid}`)
  }
  return identifiers
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
