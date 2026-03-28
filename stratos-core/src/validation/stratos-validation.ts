import { AtUri } from '@atproto/syntax'
import { StratosConfig, StratosValidationError } from '../types.js'
import { assertBoundaryMatchesService } from './boundary-qualification.js'

/**
 * Error codes for stratos validation failures
 */
export type StratosValidationErrorCode =
  | 'ForbiddenDomain'
  | 'CrossNamespaceReply'
  | 'CrossNamespaceEmbed'
  | 'MissingBoundary'
  | 'ReplyBoundaryEscalation'
  | 'ServiceMismatch'

/**
 * Record type for validation (loosely typed to avoid lexicon dependencies)
 */
export type RepoRecord = Record<string, unknown>

/**
 * Validates stratos records for domain boundaries and cross-namespace isolation.
 * This function should be called for any record in the zone.stratos.* namespace.
 *
 * When the record is a reply, parentBoundaries must be provided so the function
 * can enforce that reply boundaries are a subset of the parent's boundaries.
 */
export function assertStratosValidation(
  record: RepoRecord,
  collection: string,
  stratosConfig: StratosConfig | undefined,
  parentBoundaries?: string[],
): void {
  // Only validate zone.stratos.* collections
  if (!collection.startsWith('zone.stratos.')) {
    return
  }

  // Check that stratos is enabled (has allowed domains configured)
  if (!stratosConfig || stratosConfig.allowedDomains.length === 0) {
    throw new StratosValidationError(
      'Stratos namespace is not enabled on this service',
      'ForbiddenDomain',
    )
  }

  // Validate boundary for stratos posts
  if (collection === 'zone.stratos.feed.post') {
    assertStratosPostValidation(record, stratosConfig, parentBoundaries)
  }
}

/**
 * Validates a stratos post record for domain boundaries and cross-namespace isolation.
 */
function assertStratosPostValidation(
  record: RepoRecord,
  stratosConfig: StratosConfig,
  parentBoundaries?: string[],
): void {
  // Check boundary property exists
  const boundary = record.boundary as
    | { $type?: string; values?: Array<{ value: string }> }
    | undefined
  if (!boundary || !boundary.values || boundary.values.length === 0) {
    throw new StratosValidationError(
      'Stratos post must have a boundary with at least one domain',
      'MissingBoundary',
    )
  }

  // Validate each domain in the boundary
  for (const domain of boundary.values) {
    if (!stratosConfig.allowedDomains.includes(domain.value)) {
      throw new StratosValidationError(
        `Domain "${domain.value}" is not allowed on this service. Allowed domains: ${stratosConfig.allowedDomains.join(', ')}`,
        'ForbiddenDomain',
      )
    }

    try {
      assertBoundaryMatchesService(domain.value, stratosConfig.serviceDid)
    } catch {
      throw new StratosValidationError(
        `Boundary "${domain.value}" does not belong to this service (${stratosConfig.serviceDid})`,
        'ServiceMismatch',
      )
    }
  }

  // Validate cross-namespace isolation for replies
  const reply = record.reply as
    | {
        parent?: { uri?: string }
        root?: { uri?: string }
      }
    | undefined
  if (reply) {
    if (reply.parent?.uri && !isStratosUri(reply.parent.uri)) {
      throw new StratosValidationError(
        'Stratos post cannot reply to a non-stratos record',
        'CrossNamespaceReply',
      )
    }
    if (reply.root?.uri && !isStratosUri(reply.root.uri)) {
      throw new StratosValidationError(
        'Stratos post cannot have a non-stratos root',
        'CrossNamespaceReply',
      )
    }

    // Reply boundaries must be a subset of the parent's boundaries
    if (parentBoundaries) {
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
  }

  // Validate cross-namespace isolation for embeds
  assertNoCrossNamespaceEmbed(record.embed, 'stratos')
}

/**
 * Validates that bsky records don't embed stratos content.
 */
export function assertBskyNoCrossNamespaceEmbed(
  record: RepoRecord,
  collection: string,
): void {
  // Only validate app.bsky.* collections
  if (!collection.startsWith('app.bsky.')) {
    return
  }

  // Check embeds in posts
  if (collection === 'app.bsky.feed.post') {
    assertNoCrossNamespaceEmbed(record.embed, 'bsky')
  }
}

/**
 * Validates that an embed doesn't cross namespace boundaries.
 */
function assertNoCrossNamespaceEmbed(
  embed: unknown,
  namespace: 'stratos' | 'bsky',
): void {
  if (!embed || typeof embed !== 'object') {
    return
  }

  const isInvalidUri = namespace === 'stratos' ? isBskyUri : isStratosUri
  const errorMessage =
    namespace === 'stratos'
      ? 'Stratos post cannot embed bsky content'
      : 'Bsky post cannot embed stratos content'

  // Check direct record embeds
  const recordEmbed = embed as {
    record?: { uri?: string }
    media?: unknown
  }

  if (recordEmbed.record?.uri && isInvalidUri(recordEmbed.record.uri)) {
    throw new StratosValidationError(errorMessage, 'CrossNamespaceEmbed')
  }

  // Check record-with-media embeds
  if (recordEmbed.media && typeof recordEmbed.media === 'object') {
    assertNoCrossNamespaceEmbed(recordEmbed.media, namespace)
  }
}

/**
 * Checks if a URI references a stratos collection.
 */
export function isStratosUri(uri: string): boolean {
  try {
    const parsed = new AtUri(uri)
    return parsed.collection.startsWith('zone.stratos.')
  } catch {
    return false
  }
}

/**
 * Checks if a URI references a bsky collection.
 */
export function isBskyUri(uri: string): boolean {
  try {
    const parsed = new AtUri(uri)
    return parsed.collection.startsWith('app.bsky.')
  } catch {
    return false
  }
}

/**
 * Checks if a collection belongs to the stratos namespace.
 * Stratos records are stored in a separate database and excluded from public sync.
 */
export function isStratosCollection(collection: string): boolean {
  return collection.startsWith('zone.stratos.')
}

/**
 * Extracts boundary domain values from a stratos record.
 */
export function extractBoundaryDomains(record: RepoRecord): string[] {
  const boundary = record.boundary as
    | { $type?: string; values?: Array<{ value: string }> }
    | undefined
  return boundary?.values?.map((d) => d.value) ?? []
}
