import type { NewLabel, StoredLabel } from './types.js'

export type AppendLabelResult =
  | { kind: 'appended'; label: StoredLabel }
  | { kind: 'stale'; latest: StoredLabel | undefined }

/**
 * Append-only store of moderation labels, ordered by `seq`.
 */
export interface LabelStore {
  latestForSubject: (subjectKey: string) => Promise<StoredLabel | undefined>

  /**
   * Labels with `seq` greater than `cursor` and, when given, at most `upTo`,
   * ascending, at most `limit`. `subjects` keeps only labels whose subject key
   * is listed; an empty list matches nothing.
   */
  listFrom: (opts: {
    cursor?: number
    limit: number
    upTo?: number
    subjects?: string[]
  }) => Promise<StoredLabel[]>

  /**
   * The subset of `subjectKeys` whose latest label, by `seq`, is a takedown
   * rather than a negation. One query; no query for an empty list.
   */
  latestTakedowns: (subjectKeys: string[]) => Promise<Set<string>>

  /** Highest `seq` in the log, or `0` when it is empty. */
  headSeq: () => Promise<number>

  /**
   * Appends `label` only if the subject's latest `seq` is still
   * `expectedLatestSeq` (`null` when the subject has no label yet).
   *
   * Appends are serialized so commit order equals `seq` order, which keeps a
   * cursor reader from skipping a label. The re-check under that serialization
   * makes identical concurrent requests append once.
   */
  appendIfLatest: (
    expectedLatestSeq: number | null,
    label: NewLabel,
  ) => Promise<AppendLabelResult>
}
