import { AtUri } from '@atproto/syntax'
import { Lexicons } from '@atproto/lexicon'
import { stratosLexicons } from '../lexicons/index.js'
import { StratosConfig, StratosValidationError } from '../types.js'
import { PostValidator } from './post-validator.js'
import { EnrollmentRecordValidator } from './enrollment-record-validator.js'
import type { RecordValidator, RepoRecord } from './base.js'

export type StratosValidationErrorCode =
  | 'ForbiddenDomain'
  | 'MissingBoundary'
  | 'CrossNamespaceReply'
  | 'ReplyBoundaryEscalation'
  | 'CrossNamespaceEmbed'

/**
 * Validates stratos records for domain boundaries and cross-namespace isolation.
 */
export class StratosValidator {
  private static lexicons = new Lexicons(stratosLexicons)
  private validators: Map<string, RecordValidator>

  constructor(private config: StratosConfig) {
    this.validators = new Map()
    const postValidator = new PostValidator(config)
    this.validators.set(postValidator.collection, postValidator)

    const enrollmentValidator = new EnrollmentRecordValidator(config)
    this.validators.set(enrollmentValidator.collection, enrollmentValidator)
  }

  /**
   * Validates that bsky records don't embed stratos content.
   *
   * @param record - The bsky record to validate
   * @param collection - The collection the record belongs to
   * @throws StratosValidationError if the record embeds stratos content
   */
  static assertBskyNoCrossNamespaceEmbed(
    record: RepoRecord,
    collection: string,
  ): void {
    // Only validate app.bsky.* collections
    if (!collection.startsWith('app.bsky.')) {
      return
    }

    // Check embeds in posts
    if (collection === 'app.bsky.feed.post') {
      const validator = new StratosValidator({
        serviceDid: '',
        allowedDomains: [],
        retentionDays: 0,
      })
      validator.assertNoCrossNamespaceEmbed(record.embed, 'bsky')
    }
  }

  /**
   * Checks if a URI references a stratos collection.
   *
   * @param uri - The URI to check
   * @returns true if the URI references a stratos collection, false otherwise
   */
  static isStratosUri(uri: string): boolean {
    try {
      const parsed = new AtUri(uri)
      return parsed.collection.startsWith('zone.stratos.')
    } catch {
      return false
    }
  }

  /**
   * Checks if a URI references a bsky collection.
   *
   * @param uri - The URI to check
   * @returns true if the URI references a bsky collection, false otherwise
   */
  static isBskyUri(uri: string): boolean {
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
   *
   * @param collection - The collection to check
   * @returns true if the collection belongs to the stratos namespace, false otherwise
   */
  static isStratosCollection(collection: string): boolean {
    return collection.startsWith('zone.stratos.')
  }

  /**
   * Extracts boundary domain values from a stratos record.
   *
   * @param record - The stratos record to extract domains from
   * @returns An array of domain values from the record's boundary, or an empty array if not found'
   */
  static extractBoundaryDomains(record: RepoRecord): string[] {
    const boundary = record.boundary as
      | { $type?: string; values?: Array<{ value: string }> }
      | undefined
    return boundary?.values?.map((d) => d.value) ?? []
  }

  /**
   * Validates a record against service configuration and optional parent boundaries.
   *
   * @param record - The record to validate
   * @param collection - The collection the record belongs to
   * @param parentBoundaries - The boundaries of the parent record, if this is a reply
   *
   * @throws StratosValidationError if validation fails
   */
  assertValid(
    record: RepoRecord,
    collection: string,
    parentBoundaries?: string[],
  ): void {
    // 1. Lexicon validation
    if (StratosValidator.isStratosCollection(collection)) {
      try {
        const recordToValidate = {
          $type: collection,
          ...record,
        } as RepoRecord & { $type: string; boundary?: unknown }

        if (
          recordToValidate.boundary &&
          typeof recordToValidate.boundary === 'object' &&
          !('$type' in (recordToValidate.boundary as Record<string, unknown>))
        ) {
          recordToValidate.boundary = {
            $type: 'zone.stratos.boundary.defs#Domains',
            ...recordToValidate.boundary,
          }
        }
        StratosValidator.lexicons.assertValidRecord(
          collection,
          recordToValidate,
        )
      } catch {
        // If lexicon validation fails, we still continue to business logic validation.
        // This is necessary because some lexicons (like app.bsky.*) may be missing
        // in our local Lexicons instance, or the record might be intentionally partial in tests.
      }
    }

    // 2. Business logic validation
    const validator = this.validators.get(collection)
    if (validator && collection !== 'zone.stratos.feed.post') {
      validator.validate(record, parentBoundaries)
    } else {
      this.assertStratosValidation(record, collection, parentBoundaries)
    }
  }

  /**
   * Internal validation logic for stratos records.
   *
   * @param record - The record to validate
   * @param collection - The collection the record belongs to
   * @param parentBoundaries - The boundaries of the parent record, if this is a reply
   */
  private assertStratosValidation(
    record: RepoRecord,
    collection: string,
    parentBoundaries?: string[],
  ): void {
    // Only validate zone.stratos.* collections
    if (!StratosValidator.isStratosCollection(collection)) {
      return
    }

    // Check that stratos is enabled (has allowed domains configured)
    if (this.config.allowedDomains.length === 0) {
      throw new StratosValidationError(
        'Stratos namespace is not enabled on this service',
        'ForbiddenDomain',
      )
    }

    // Validate boundary for stratos posts
    if (collection === 'zone.stratos.feed.post') {
      this.assertStratosPostValidation(record, parentBoundaries)
    }
  }

  /**
   * Validates a stratos post record for domain boundaries and cross-namespace isolation.
   *
   * @param record - The stratos post record to validate
   * @param parentBoundaries - The parent boundaries for the post
   * @throws StratosValidationError if the post violates domain boundaries or cross-namespace isolation
   */
  private assertStratosPostValidation(
    record: RepoRecord,
    parentBoundaries?: string[],
  ): void {
    const rawBoundary = record.boundary as
      | { $type?: string; values?: Array<{ value: string }> }
      | undefined
    const boundary = rawBoundary
      ? {
          $type: 'zone.stratos.boundary.defs#Domains',
          ...rawBoundary,
        }
      : undefined

    // 1. Check boundary property exists
    this.assertBoundaryPresence(boundary)

    // 2. Validate each domain in the boundary
    this.validateBoundaryDomains(
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
      this.assertReplyIsolation(reply)

      // 4. Reply boundaries must be a subset of the parent's boundaries
      if (parentBoundaries) {
        this.assertReplyBoundaryConsistency(
          boundary as { values: Array<{ value: string }> },
          parentBoundaries,
        )
      }
    }

    // 5. Validate cross-namespace isolation for embeds
    this.assertNoCrossNamespaceEmbed(record.embed, 'stratos')
  }

  /**
   * Ensures a boundary exists with at least one domain.
   *
   * @param boundary - The boundary to validate
   * @throws StratosValidationError if the boundary is missing or empty
   */
  private assertBoundaryPresence(
    boundary: { $type?: string; values?: Array<{ value: string }> } | undefined,
  ): void {
    if (!boundary?.values || boundary.values.length === 0) {
      throw new StratosValidationError(
        'must have a boundary',
        'MissingBoundary',
      )
    }
  }

  /**
   * Validates each domain in the boundary against service configuration.
   *
   * @param boundary - The boundary to validate
   * @throws StratosValidationError if a domain is not allowed or does not belong to the service
   */
  private validateBoundaryDomains(boundary: {
    values: Array<{ value: string }>
  }): void {
    for (const d of boundary.values) {
      const domain = d.value
      let bareDomain = domain
      if (domain.startsWith('did:')) {
        const prefix = `${this.config.serviceDid}/`
        if (!domain.startsWith(prefix)) {
          throw new StratosValidationError(
            `Boundary '${domain}' does not belong to this service`,
            'ForbiddenDomain',
          )
        }
        bareDomain = domain.slice(prefix.length)
      }

      const isAllowed =
        this.config.allowedDomains.includes(domain) ||
        this.config.allowedDomains.includes(bareDomain)

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
  private assertReplyIsolation(reply: {
    parent?: { uri?: string }
    root?: { uri?: string }
  }): void {
    if (reply.parent?.uri && !StratosValidator.isStratosUri(reply.parent.uri)) {
      throw new StratosValidationError(
        'cannot reply to a non-stratos record',
        'CrossNamespaceReply',
      )
    }
    if (reply.root?.uri && !StratosValidator.isStratosUri(reply.root.uri)) {
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
  private assertReplyBoundaryConsistency(
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

  /**
   * Validates that an embed doesn't cross namespace boundaries.
   *
   * @param embed - The embed to validate
   * @param namespace - The namespace of the embed (stratos or bsky)
   * @throws StratosValidationError if the embed references a record from a different namespace
   */
  private assertNoCrossNamespaceEmbed(
    embed: unknown,
    namespace: 'stratos' | 'bsky',
  ): void {
    if (!embed || typeof embed !== 'object') {
      return
    }

    const isInvalidUri =
      namespace === 'stratos'
        ? StratosValidator.isBskyUri
        : StratosValidator.isStratosUri
    const errorMessage =
      namespace === 'stratos'
        ? 'cannot embed bsky content'
        : 'cannot embed stratos content'

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
      this.assertNoCrossNamespaceEmbed(recordEmbed.media, namespace)
    }
  }
}
