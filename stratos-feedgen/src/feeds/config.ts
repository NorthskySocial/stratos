import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { parse as parseYaml } from 'yaml'

export interface FeedDescription {
  id: string
  boundary: string
  displayName?: string
  description?: string
}

export interface FeedRegistry {
  list: () => FeedDescription[]
  get: (id: string) => FeedDescription | undefined
}

interface FeedsFileShape {
  feeds: unknown
}

/**
 * Load feed config from one of:
 *
 *   - `FEEDGEN_FEEDS_FILE` — path to a `.json`, `.yaml`, or `.yml` file
 *   - `FEEDGEN_FEEDS_JSON` — inline JSON string
 *   - `FEEDGEN_FEEDS_YAML` — inline YAML string
 *
 * Exactly one must be set.
 *
 * Expected shape (both formats):
 *
 *   feeds:
 *     - id: engineering
 *       boundary: example.com/engineering
 *       displayName: Engineering        # optional
 *       description: Internal posts     # optional
 */
export function loadFeedRegistry(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): FeedRegistry {
  const filePath = env['FEEDGEN_FEEDS_FILE']
  const inlineJson = env['FEEDGEN_FEEDS_JSON']
  const inlineYaml = env['FEEDGEN_FEEDS_YAML']
  const sources = [filePath, inlineJson, inlineYaml].filter(
    (v): v is string => v !== undefined && v !== '',
  )
  if (sources.length > 1) {
    throw new Error(
      'Set only one of FEEDGEN_FEEDS_FILE, FEEDGEN_FEEDS_JSON, or FEEDGEN_FEEDS_YAML',
    )
  }
  if (sources.length === 0) {
    throw new Error(
      'One of FEEDGEN_FEEDS_FILE, FEEDGEN_FEEDS_JSON, or FEEDGEN_FEEDS_YAML must be set',
    )
  }

  if (filePath) {
    const raw = readFileSync(filePath, 'utf-8')
    return buildFeedRegistry(parseFeeds(raw, detectFormat(filePath)))
  }
  if (inlineJson) {
    return buildFeedRegistry(parseFeeds(inlineJson, 'json'))
  }
  return buildFeedRegistry(parseFeeds(inlineYaml as string, 'yaml'))
}

type Format = 'json' | 'yaml'

function detectFormat(path: string): Format {
  const ext = extname(path).toLowerCase()
  if (ext === '.yaml' || ext === '.yml') return 'yaml'
  if (ext === '.json') return 'json'
  throw new Error(
    `Unsupported feed config extension: ${ext} (expected .json, .yaml, or .yml)`,
  )
}

export function buildFeedRegistry(feeds: FeedDescription[]): FeedRegistry {
  const byId = new Map<string, FeedDescription>()
  for (const feed of feeds) {
    if (byId.has(feed.id)) {
      throw new Error(`Duplicate feed id: ${feed.id}`)
    }
    byId.set(feed.id, feed)
  }
  return {
    list: () => [...byId.values()],
    get: (id) => byId.get(id),
  }
}

function parseFeeds(raw: string, format: Format): FeedDescription[] {
  let parsed: unknown
  try {
    parsed = format === 'yaml' ? parseYaml(raw) : JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `Feed config is not valid ${format.toUpperCase()}: ${(err as Error).message}`,
      { cause: err },
    )
  }
  if (!isFeedsFile(parsed)) {
    throw new Error('Feed config must be an object with a "feeds" array')
  }
  const out: FeedDescription[] = []
  for (const [i, entry] of parsed.feeds.entries()) {
    out.push(validateFeed(entry, i))
  }
  return out
}

function isFeedsFile(v: unknown): v is { feeds: unknown[] } {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as FeedsFileShape).feeds)
  )
}

function validateFeed(entry: unknown, index: number): FeedDescription {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`feeds[${index}] is not an object`)
  }
  const e = entry as Record<string, unknown>
  const id = e['id']
  const boundary = e['boundary']
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`feeds[${index}].id is required (string)`)
  }
  if (typeof boundary !== 'string' || boundary.length === 0) {
    throw new Error(`feeds[${index}].boundary is required (string)`)
  }
  const out: FeedDescription = { id, boundary }
  if (typeof e['displayName'] === 'string') {
    out.displayName = e['displayName']
  }
  if (typeof e['description'] === 'string') {
    out.description = e['description']
  }
  return out
}
