import { AtUri } from '@atproto/syntax'
import {
  AT_SCHEME,
  isValidNsidStr,
  isValidRkey,
  parseRecordUri,
} from '../spaces/domain.js'
import { StratosConfig, StratosValidationError } from '../types.js'
import type { RepoRecord } from './base.js'
import type { RecordRule, RecordRuleInput } from './registry.js'

export const POST_COLLECTION = 'zone.stratos.feed.post'

const REPO_URI_PART_COUNT = 3
const DOMAINS_TYPE = 'zone.stratos.boundary.defs#Domains'

type EmbedNamespace = 'stratos' | 'bsky'

/**
 * The collection a record URI names: the `collection` part of a space record
 * URI, or of a three-part `at://` record URI. Anything else, including a space
 * URI handed to the public parser, names none. A space URI never reaches
 * `AtUri`, which throws on it.
 */
export function recordUriCollection(uri: unknown): string | undefined {
  if (typeof uri !== 'string') return undefined
  const spaceRecord = parseRecordUri(uri)
  if (spaceRecord.ok) return spaceRecord.value.collection
  if (!uri.startsWith(AT_SCHEME)) return undefined
  const repoUriParts = uri.slice(AT_SCHEME.length).split('/')
  if (repoUriParts.length !== REPO_URI_PART_COUNT) return undefined
  // `AtUri` takes any character but whitespace, `?` and `#` after the
  // authority, so a NUL or another control character would pass through it.
  const [, collection, rkey] = repoUriParts
  if (!isValidNsidStr(collection) || !isValidRkey(rkey)) return undefined
  try {
    return new AtUri(uri).collection
  } catch {
    return undefined
  }
}

/**
 * Checks if a URI references a stratos collection.
 *
 * Strict, because a reply has to point at a record by a URI that addresses
 * it. The embed guard on public posts reads more loosely, see
 * {@link isStratosEmbedUri}.
 *
 * @param uri - The URI to check
 * @returns true if the URI references a stratos collection, false otherwise
 */
export function isStratosUri(uri: string): boolean {
  return recordUriCollection(uri)?.startsWith('zone.stratos.') ?? false
}

/**
 * Reads as loosely as {@link isBskyUri}, so a public post cannot embed a
 * Stratos record in any spelling the upstream parser reads.
 */
function isStratosEmbedUri(uri: string): boolean {
  const collection = recordUriCollection(uri) ?? lenientUriCollection(uri)
  return collection?.startsWith('zone.stratos.') ?? false
}

/**
 * Checks if a URI references a bsky collection.
 *
 * @param uri - The URI to check
 * @returns true if the URI references a bsky collection, false otherwise
 */
export function isBskyUri(uri: string): boolean {
  const collection = recordUriCollection(uri) ?? lenientUriCollection(uri)
  return collection?.startsWith('app.bsky.') ?? false
}

/**
 * The embed guards have to refuse every spelling the upstream parser reads
 * (any scheme case, no scheme, any depth), not only the strict forms, because
 * they are the only guard on the legacy write path.
 */
function lenientUriCollection(uri: string): string | undefined {
  try {
    return new AtUri(uri).collection
  } catch {
    return undefined
  }
}

/**
 * Validates that an embed doesn't cross namespace boundaries.
 *
 * @param embed - The embed to validate
 * @param namespace - The namespace of the embed (stratos or bsky)
 * @throws StratosValidationError if the embed references a record from a different namespace
 */
export function assertNoCrossNamespaceEmbed(
  embed: unknown,
  namespace: EmbedNamespace,
): void {
  if (!embed || typeof embed !== 'object') {
    return
  }

  const isInvalidUri = namespace === 'stratos' ? isBskyUri : isStratosEmbedUri
  const errorMessage =
    namespace === 'stratos'
      ? 'cannot embed bsky content'
      : 'cannot embed stratos content'

  // Check direct record embeds
  const recordEmbed = embed as {
    record?: { uri?: string }
    media?: unknown
  }

  const embeddedUri = recordEmbed.record?.uri
  if (embeddedUri && isInvalidUri(embeddedUri)) {
    throw new StratosValidationError(errorMessage, 'CrossNamespaceEmbed')
  }

  // Check record-with-media embeds
  if (recordEmbed.media && typeof recordEmbed.media === 'object') {
    assertNoCrossNamespaceEmbed(recordEmbed.media, namespace)
  }
}

/**
 * The rule for stratos posts, built for one service configuration.
 */
export function createPostRule(config: StratosConfig): RecordRule {
  return {
    collection: POST_COLLECTION,
    check: (record, input) =>
      assertStratosPostValidation(config, record, input),
  }
}

/**
 * Validates a stratos post record for domain boundaries and cross-namespace isolation.
 *
 * @param config - The service configuration
 * @param record - The stratos post record to validate
 * @param input - The boundaries the post is written into and the parent's boundaries
 * @throws StratosValidationError if the post violates domain boundaries or cross-namespace isolation
 */
function assertStratosPostValidation(
  config: StratosConfig,
  record: RepoRecord,
  input: RecordRuleInput,
): void {
  const rawBoundary = input.boundaryClaim as
    { $type?: string; values?: Array<{ value: string }> } | undefined
  const boundary = rawBoundary
    ? {
        $type: DOMAINS_TYPE,
        ...rawBoundary,
      }
    : undefined

  // 1. Check boundary property exists
  assertBoundaryPresence(boundary)

  // 2. Validate each domain in the boundary
  validateBoundaryDomains(
    config,
    boundary as { values: Array<{ value: string }> },
  )

  // 3. Validate cross-namespace isolation for replies
  const reply = record.reply as
    | {
        parent?: { uri?: string }
        root?: { uri?: string }
      }
    | undefined

  if (reply) {
    assertReplyIsolation(reply)

    // 4. Reply boundaries must be a subset of the parent's boundaries
    if (input.parentBoundaries) {
      assertReplyBoundaryConsistency(
        boundary as { values: Array<{ value: string }> },
        input.parentBoundaries,
      )
    }
  }

  // 5. Validate cross-namespace isolation for embeds
  assertNoCrossNamespaceEmbed(record.embed, 'stratos')
}

/**
 * Ensures a boundary exists with at least one domain.
 *
 * @param boundary - The boundary to validate
 * @throws StratosValidationError if the boundary is missing or empty
 */
function assertBoundaryPresence(
  boundary: { $type?: string; values?: Array<{ value: string }> } | undefined,
): void {
  if (!boundary?.values || boundary.values.length === 0) {
    throw new StratosValidationError('must have a boundary', 'MissingBoundary')
  }
}

/**
 * Validates each domain in the boundary against service configuration.
 *
 * @param config - The service configuration
 * @param boundary - The boundary to validate
 * @throws StratosValidationError if a domain is not allowed or does not belong to the service
 */
function validateBoundaryDomains(
  config: StratosConfig,
  boundary: { values: Array<{ value: string }> },
): void {
  for (const d of boundary.values) {
    const domain = d.value
    let bareDomain = domain
    if (domain.startsWith('did:')) {
      const prefix = `${config.serviceDid}/`
      if (!domain.startsWith(prefix)) {
        throw new StratosValidationError(
          `Boundary '${domain}' does not belong to this service`,
          'ForbiddenDomain',
        )
      }
      bareDomain = domain.slice(prefix.length)
    }

    const isAllowed =
      config.allowedDomains.includes(domain) ||
      config.allowedDomains.includes(bareDomain)

    if (!isAllowed) {
      throw new StratosValidationError(
        `Domain '${bareDomain}' is not allowed`,
        'ForbiddenDomain',
      )
    }
  }
}

/**
 * Ensures that a reply only references other Stratos records.
 *
 * @param reply - The reply to validate
 * @throws StratosValidationError if the reply references a non-stratos record
 */
function assertReplyIsolation(reply: {
  parent?: { uri?: string }
  root?: { uri?: string }
}): void {
  if (reply.parent?.uri && !isStratosUri(reply.parent.uri)) {
    throw new StratosValidationError(
      'cannot reply to a non-stratos record',
      'CrossNamespaceReply',
    )
  }
  if (reply.root?.uri && !isStratosUri(reply.root.uri)) {
    throw new StratosValidationError(
      'cannot have a non-stratos root',
      'CrossNamespaceReply',
    )
  }
}

/**
 * Ensures that reply boundaries are a subset of parent boundaries.
 *
 * @param boundary - The boundary to validate
 * @param parentBoundaries - The parent boundaries
 * @throws StratosValidationError if the reply boundaries are not a subset of the parent boundaries
 */
function assertReplyBoundaryConsistency(
  boundary: { values: Array<{ value: string }> },
  parentBoundaries: string[],
): void {
  const replyDomains = boundary.values.map((d) => d.value)
  const escalatedDomains = replyDomains.filter(
    (domain) => !parentBoundaries.includes(domain),
  )

  if (escalatedDomains.length > 0) {
    throw new StratosValidationError(
      `Reply boundaries must be a subset of the parent's boundaries. Domains not in parent: ${escalatedDomains.join(', ')}`,
      'ReplyBoundaryEscalation',
    )
  }
}
