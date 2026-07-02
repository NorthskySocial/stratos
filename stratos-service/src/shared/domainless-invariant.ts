import { isDomainlessRecord, type Logger } from '@northskysocial/stratos-core'

/**
 * Log the single-domain invariant violation for a record that reached an access
 * check with no domain. The write path enforces exactly one domain per record,
 * so a domainless record is a data-integrity anomaly. Such records are
 * fail-closed inaccessible by {@link canAccessRecord}; this only records the
 * anomaly for operators.
 *
 * @param logger - Optional structured logger.
 * @param recordBoundaries - The record's boundary domains.
 * @param context - Identifying fields for the offending record (uri/owner).
 */
export function logDomainlessInvariant(
  logger: Logger | undefined,
  recordBoundaries: string[],
  context: { uri?: string; ownerDid: string },
): void {
  if (!isDomainlessRecord(recordBoundaries)) return
  logger?.warn(
    { uri: context.uri, ownerDid: context.ownerDid },
    'invariant violation: record has no domain; treating as fail-closed inaccessible',
  )
}
