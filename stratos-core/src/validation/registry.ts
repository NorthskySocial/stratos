import { StratosConfig } from '../types.js'
import type { RepoRecord } from './base.js'
import { EnrollmentRecordValidator } from './enrollment-record-validator.js'
import { createLikeRule } from './like-rule.js'
import { createPostRule } from './post-rules.js'
import { createRepostRule } from './repost-rule.js'

export interface RecordRuleInput {
  /** The boundary claim exactly as the caller supplied it, whatever its shape. */
  boundaryClaim: unknown
  /** The boundaries of the parent record, if this is a reply. */
  parentBoundaries?: string[]
  /**
   * What the service found out about the record's subject. Absent when it did
   * not look, so a rule that needs it fails closed.
   */
  subject?: { eligible: boolean }
}

export interface RecordRule {
  collection: string
  /**
   * Set when the record names a subject. The service resolves the subject
   * against these collections before it runs `check`.
   */
  subject?: { collections: readonly string[] }
  /** @throws StratosValidationError if the record breaks the rule. */
  check: (record: RepoRecord, input: RecordRuleInput) => void
}

export type RecordRuleBuilder = (config: StratosConfig) => RecordRule

function createEnrollmentRule(config: StratosConfig): RecordRule {
  const validator = new EnrollmentRecordValidator(config)
  return {
    collection: validator.collection,
    check: (record, input) =>
      validator.validate(record, input.parentBoundaries),
  }
}

/** One line per collection with a rule; the rules need the service's config. */
export const RECORD_RULE_BUILDERS: readonly RecordRuleBuilder[] = [
  createPostRule,
  createEnrollmentRule,
  createLikeRule,
  createRepostRule,
]

export function buildRecordRules(
  config: StratosConfig,
): ReadonlyMap<string, RecordRule> {
  return new Map(
    RECORD_RULE_BUILDERS.map((build) => {
      const rule = build(config)
      return [rule.collection, rule]
    }),
  )
}

export function findRecordRule(
  rules: ReadonlyMap<string, RecordRule>,
  collection: string,
): RecordRule | undefined {
  return rules.get(collection)
}
