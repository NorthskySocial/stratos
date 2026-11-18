import { StratosConfig } from '../types.js'
import type { RepoRecord } from './base.js'
import { EnrollmentRecordValidator } from './enrollment-record-validator.js'
import { createPostRule } from './post-rules.js'

export interface RecordRuleInput {
  /** The boundary claim exactly as the caller supplied it, whatever its shape. */
  boundaryClaim: unknown
  /** The boundaries of the parent record, if this is a reply. */
  parentBoundaries?: string[]
}

export interface RecordRule {
  collection: string
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
