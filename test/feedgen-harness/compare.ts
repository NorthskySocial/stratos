import {
  compareShadowFeedDecisions,
  type ShadowFeedDecision,
  type ShadowMismatchReason,
} from './feed-comparator.js'

const FEED_ENDPOINT = '/xrpc/zone.stratos.feedgen.getFeed'
const MAX_RESPONSE_BYTES = 1_048_576
const DEFAULT_REQUEST_TIMEOUT_MS = 1_000

export interface FeedEndpointComparisonInput {
  baselineBaseUrl: string
  candidateBaseUrl: string
  authorization: string
  feed: string
  cursor?: string
  limit?: number
  requestTimeoutMs?: number
  allowRemote?: boolean
  fetch?: typeof globalThis.fetch
}

export type FeedEndpointComparison =
  | {
      outcome: 'matched'
      baselineStatus: number
      candidateStatus: number
    }
  | {
      outcome: 'mismatch'
      reason: ShadowMismatchReason
      baselineStatus: number
      candidateStatus: number
    }

/**
 * Compares two authenticated feed responses without retaining their bodies,
 * authorization value, or post identifiers after the comparison completes.
 */
export async function compareFeedEndpoints(
  input: FeedEndpointComparisonInput,
): Promise<FeedEndpointComparison> {
  const fetch = input.fetch ?? globalThis.fetch
  const baselineUrl = feedUrl(input.baselineBaseUrl, input)
  const candidateUrl = feedUrl(input.candidateBaseUrl, input)
  if (!input.allowRemote) {
    assertLoopback(baselineUrl)
    assertLoopback(candidateUrl)
  }
  const options = {
    headers: { authorization: input.authorization },
    redirect: 'error' as const,
    signal: AbortSignal.timeout(
      input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    ),
  }
  const [baselineResponse, candidateResponse] = await Promise.all([
    fetch(baselineUrl, options),
    fetch(candidateUrl, options),
  ])
  const [baseline, candidate] = await Promise.all([
    feedDecision(baselineResponse),
    feedDecision(candidateResponse),
  ])
  const comparison = compareShadowFeedDecisions(baseline, candidate)
  return comparison.matched
    ? {
        outcome: 'matched',
        baselineStatus: baseline.status,
        candidateStatus: candidate.status,
      }
    : {
        outcome: 'mismatch',
        reason: comparison.reason,
        baselineStatus: baseline.status,
        candidateStatus: candidate.status,
      }
}

function feedUrl(baseUrl: string, input: FeedEndpointComparisonInput): URL {
  const url = new URL(FEED_ENDPOINT, baseUrl)
  url.search = new URLSearchParams({
    feed: input.feed,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.limit === undefined ? {} : { limit: String(input.limit) }),
  }).toString()
  return url
}

function assertLoopback(url: URL): void {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('compare requires loopback endpoints unless --allow-remote')
  }
}

async function feedDecision(response: Response): Promise<ShadowFeedDecision> {
  const value = await boundedJson(response)
  if (!isObject(value)) return invalidDecision(response.status)
  if (response.status !== 200) {
    const error = value['error']
    return typeof error === 'string'
      ? {
          status: response.status,
          error: error.slice(0, 64),
          postIdentifiers: [],
        }
      : invalidDecision(response.status)
  }
  const feed = value['feed']
  if (!Array.isArray(feed)) return invalidDecision(response.status)
  const postIdentifiers: string[] = []
  for (const item of feed) {
    if (!isObject(item) || !isObject(item['post']))
      return invalidDecision(response.status)
    const uri = item['post']['uri']
    const cid = item['post']['cid']
    if (typeof uri !== 'string' || typeof cid !== 'string') {
      return invalidDecision(response.status)
    }
    postIdentifiers.push(`${uri}#${cid}`)
  }
  const cursor = value['cursor']
  if (cursor !== undefined && typeof cursor !== 'string') {
    return invalidDecision(response.status)
  }
  return { status: response.status, cursor, postIdentifiers }
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('compare response has no body')
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('compare response exceeded byte limit')
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

function invalidDecision(status: number): ShadowFeedDecision {
  return { status, error: 'InvalidShadowResponse', postIdentifiers: [] }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
