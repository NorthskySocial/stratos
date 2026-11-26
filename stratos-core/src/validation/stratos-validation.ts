import { Lexicons } from '@atproto/lexicon'
import { parseCid } from '../atproto'
import { stratosLexicons } from '../lexicons'
import { StratosConfig, StratosValidationError } from '../types.js'
import {
  POST_COLLECTION,
  assertNoCrossNamespaceEmbed,
  isBskyUri,
  isStratosUri,
} from './post-rules.js'
import { buildRecordRules, findRecordRule } from './registry.js'
import type { RecordRule, RecordRuleInput } from './registry.js'
import type { RepoRecord } from './base.js'

export type StratosValidationErrorCode =
  | 'ForbiddenDomain'
  | 'MissingBoundary'
  | 'CrossNamespaceReply'
  | 'ReplyBoundaryEscalation'
  | 'CrossNamespaceEmbed'
  | 'InvalidSubject'

/**
 * Validates stratos records for domain boundaries and cross-namespace isolation.
 */
export class StratosValidator {
  private static lexicons = new Lexicons(stratosLexicons)
  private rules: ReadonlyMap<string, RecordRule>

  constructor(private config: StratosConfig) {
    this.rules = buildRecordRules(config)
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
      assertNoCrossNamespaceEmbed(record.embed, 'bsky')
    }
  }

  /**
   * Checks if a URI references a stratos collection.
   *
   * @param uri - The URI to check
   * @returns true if the URI references a stratos collection, false otherwise
   */
  static isStratosUri(uri: string): boolean {
    return isStratosUri(uri)
  }

  /**
   * Checks if a URI references a bsky collection.
   *
   * @param uri - The URI to check
   * @returns true if the URI references a bsky collection, false otherwise
   */
  static isBskyUri(uri: string): boolean {
    return isBskyUri(uri)
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
      { $type?: string; values?: Array<{ value: string }> } | undefined
    return boundary?.values?.map((d) => d.value) ?? []
  }

  /**
   * Recursively extracts all blob CIDs from a record.
   *
   * @param record - The record to extract blobs from
   * @returns An array of unique blob CIDs found in the record
   */
  static extractBlobs(record: unknown): string[] {
    const blobs = new Set<string>()
    const traverse = (val: unknown) => {
      if (!val || typeof val !== 'object') return
      if (val instanceof Uint8Array) return
      if (Array.isArray(val)) {
        for (const item of val) {
          traverse(item)
        }
        return
      }

      const cid = StratosValidator.blobCidOf(val)
      if (cid !== undefined) {
        blobs.add(cid)
        return
      }

      for (const key in val) {
        traverse((val as Record<string, unknown>)[key])
      }
    }
    traverse(record)
    return [...blobs]
  }

  /**
   * Returns the CID string when the value is a blob object, in JSON wire
   * form or in lex form. Returns undefined for all other values.
   *
   * @param val - The object to inspect
   * @returns The blob CID string, or undefined
   */
  private static blobCidOf(val: object): string | undefined {
    if (
      !('ref' in val) ||
      typeof val.ref !== 'object' ||
      val.ref === null ||
      !('mimeType' in val) ||
      typeof val.mimeType !== 'string' ||
      !('size' in val) ||
      typeof val.size !== 'number'
    ) {
      return undefined
    }

    if ('$link' in val.ref) {
      // JSON wire form: a $type marker and a $link string identify the blob.
      if (!('$type' in val) || val.$type !== 'blob') return undefined
      if (typeof val.ref.$link !== 'string') return undefined
      return StratosValidator.normalizeBlobCid(val.ref.$link)
    }

    // The XRPC server converts JSON bodies to lex form before handlers run.
    // A blob then arrives as a BlobRef instance: ref holds a CID object and
    // the $type marker is gone. Match the shape, not the class, because the
    // package store holds more than one @atproto copy and instanceof fails
    // across copies.
    return StratosValidator.normalizeBlobCid(val.ref)
  }

  /**
   * Parses a CID and returns its canonical string form. Both wire and lex
   * blob forms then index the same string. Returns undefined when the CID
   * does not parse.
   */
  private static normalizeBlobCid(ref: unknown): string | undefined {
    try {
      return parseCid(ref as Parameters<typeof parseCid>[0]).toString()
    } catch {
      return undefined
    }
  }

  /**
   * Validates a record whose boundary claim is the one in its own body.
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
    this.assertValidWithInput(record, collection, {
      boundaryClaim: record.boundary,
      parentBoundaries,
    })
  }

  /**
   * Validates a record against service configuration, judging its boundary by
   * the claim in `input` instead of the claim in its body.
   *
   * @param record - The record to validate
   * @param collection - The collection the record belongs to
   * @param input - The boundary claim and the parent's boundaries
   *
   * @throws StratosValidationError if validation fails
   */
  assertValidWithInput(
    record: RepoRecord,
    collection: string,
    input: RecordRuleInput,
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
    const rule = findRecordRule(this.rules, collection)
    if (rule && collection !== POST_COLLECTION) {
      rule.check(record, input)
    } else {
      this.assertStratosValidation(record, collection, input)
    }
  }

  /**
   * Internal validation logic for stratos records.
   *
   * @param record - The record to validate
   * @param collection - The collection the record belongs to
   * @param input - The boundary claim and the parent's boundaries
   */
  private assertStratosValidation(
    record: RepoRecord,
    collection: string,
    input: RecordRuleInput,
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
    if (collection === POST_COLLECTION) {
      findRecordRule(this.rules, collection)?.check(record, input)
    }
  }
}
