/** A feed decision reduced to fields needed for in-process parity comparison. */
export interface ShadowFeedDecision {
  status: number
  error?: string
  cursor?: string
  postIdentifiers: readonly string[]
}

/** Bounded comparison outcomes suitable for a low-cardinality metric. */
export type ShadowMismatchReason =
  | 'status'
  | 'error'
  | 'cursor'
  | 'post-count'
  | 'post-order'

export type ShadowComparison =
  | { matched: true }
  | { matched: false; reason: ShadowMismatchReason }

/**
 * Compares two already-authorized feed decisions without returning any private
 * response value. Callers may record only the bounded result.
 */
export function compareShadowFeedDecisions(
  primary: ShadowFeedDecision,
  shadow: ShadowFeedDecision,
): ShadowComparison {
  if (primary.status !== shadow.status) {
    return { matched: false, reason: 'status' }
  }
  if (primary.error !== shadow.error) {
    return { matched: false, reason: 'error' }
  }
  if (primary.cursor !== shadow.cursor) {
    return { matched: false, reason: 'cursor' }
  }
  if (primary.postIdentifiers.length !== shadow.postIdentifiers.length) {
    return { matched: false, reason: 'post-count' }
  }
  if (
    primary.postIdentifiers.some(
      (identifier, index) => identifier !== shadow.postIdentifiers[index],
    )
  ) {
    return { matched: false, reason: 'post-order' }
  }
  return { matched: true }
}
