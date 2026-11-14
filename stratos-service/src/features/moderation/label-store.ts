import { createClient } from '@libsql/client'
import { and, asc, desc, eq, gt, inArray, lte, max, sql } from 'drizzle-orm'
import type {
  AppendLabelResult,
  LabelStore,
  LabelSubjectKind,
  NewLabel,
  StoredLabel,
} from '@northskysocial/stratos-core'
import { moderationLabel, type ServiceDb } from '../../db'
import { pgModerationLabel } from '../../db/pg-schema.js'
import type { ServicePgDb } from '../../db/pg.js'

/** Arbitrary fixed key; every label append on Postgres contends on it. */
const LABEL_APPEND_LOCK_KEY = 7_301_996

/** Serializes label appends within this process so they do not compete with each other for the SQLite write lock. */
const sqliteAppendQueues = new WeakMap<ServiceDb, Promise<void>>()

const SQLITE_LOCK_WAIT_MS = 10_000

interface LabelRow {
  seq: number
  subjectKey: string
  subjectKind: string
  cid: string | null
  val: string
  neg: boolean
  ref: string | null
  boundaries: string
  createdBy: string
  createdAt: string
}

function normalizeBoundaries(boundaries: string[]): string {
  return JSON.stringify([...new Set(boundaries)].sort())
}

function toStoredLabel(row: LabelRow): StoredLabel {
  const label: StoredLabel = {
    seq: row.seq,
    subjectKey: row.subjectKey,
    subjectKind: row.subjectKind as LabelSubjectKind,
    val: row.val,
    neg: row.neg,
    boundaries: JSON.parse(row.boundaries) as string[],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }
  if (row.cid !== null) label.cid = row.cid
  if (row.ref !== null) label.ref = row.ref
  return label
}

function toInsertValues(label: NewLabel) {
  return {
    subjectKey: label.subjectKey,
    subjectKind: label.subjectKind,
    cid: label.cid ?? null,
    val: label.val,
    neg: label.neg,
    ref: label.ref ?? null,
    boundaries: normalizeBoundaries(label.boundaries),
    createdBy: label.createdBy,
    createdAt: label.createdAt,
  }
}

type ListFromOptions = Parameters<LabelStore['listFrom']>[0]

function currentSeq(latest: StoredLabel | undefined): number | null {
  return latest === undefined ? null : latest.seq
}

export type SqliteClientFactory = typeof createClient

export class SqliteLabelStore implements LabelStore {
  constructor(
    private db: ServiceDb,
    private serviceDbPath: string,
    private createSqliteClient: SqliteClientFactory = createClient,
  ) {}

  async latestForSubject(subjectKey: string): Promise<StoredLabel | undefined> {
    const [row] = await this.db
      .select()
      .from(moderationLabel)
      .where(eq(moderationLabel.subjectKey, subjectKey))
      .orderBy(desc(moderationLabel.seq))
      .limit(1)
    return row ? toStoredLabel(row) : undefined
  }

  async listFrom(opts: ListFromOptions): Promise<StoredLabel[]> {
    if (opts.subjects?.length === 0) return []
    const rows = await this.db
      .select()
      .from(moderationLabel)
      .where(
        and(
          gt(moderationLabel.seq, opts.cursor ?? 0),
          opts.upTo === undefined
            ? undefined
            : lte(moderationLabel.seq, opts.upTo),
          opts.subjects === undefined
            ? undefined
            : inArray(moderationLabel.subjectKey, opts.subjects),
        ),
      )
      .orderBy(asc(moderationLabel.seq))
      .limit(opts.limit)
    return rows.map(toStoredLabel)
  }

  async headSeq(): Promise<number> {
    const [row] = await this.db
      .select({ head: max(moderationLabel.seq) })
      .from(moderationLabel)
    return row?.head ?? 0
  }

  async appendIfLatest(
    expectedLatestSeq: number | null,
    label: NewLabel,
  ): Promise<AppendLabelResult> {
    return this.appendSerialized(() =>
      this.appendGuarded(expectedLatestSeq, label),
    )
  }

  private appendSerialized<T>(append: () => Promise<T>): Promise<T> {
    const previous = sqliteAppendQueues.get(this.db) ?? Promise.resolve()
    const result = previous.then(append)
    sqliteAppendQueues.set(
      this.db,
      result.then(
        () => undefined,
        () => undefined,
      ),
    )
    return result
  }

  // A statement that fails with SQLITE_BUSY stays active on its libsql
  // connection, and only close() finalizes it. A shared connection would then
  // hold the write lock and reject its next transaction. Each attempt
  // therefore owns a fresh connection that it always closes.
  // AUTOINCREMENT seqs start at 1, so 0 stands for "no label yet".
  private async appendGuarded(
    expectedLatestSeq: number | null,
    label: NewLabel,
  ): Promise<AppendLabelResult> {
    const values = toInsertValues(label)
    const statement = {
      sql: `INSERT INTO moderation_label
          (subjectKey, subjectKind, cid, val, neg, ref, boundaries, createdBy, createdAt)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE COALESCE(
            (SELECT MAX(seq) FROM moderation_label WHERE subjectKey = ?), 0
          ) = ?
          RETURNING *`,
      args: [
        values.subjectKey,
        values.subjectKind,
        values.cid,
        values.val,
        values.neg ? 1 : 0,
        values.ref,
        values.boundaries,
        values.createdBy,
        values.createdAt,
        values.subjectKey,
        expectedLatestSeq ?? 0,
      ],
    }
    const result = await retryWhileBusy(async () => {
      const client = this.createSqliteClient({
        url: `file:${this.serviceDbPath}`,
      })
      try {
        return await client.execute(statement)
      } finally {
        client.close()
      }
    })
    const [appendedRow] = result.rows
    if (appendedRow) {
      return {
        kind: 'appended',
        label: toStoredLabel(
          toSqliteRow(appendedRow as Record<string, SqliteColumn>),
        ),
      }
    }
    return {
      kind: 'stale',
      latest: await this.latestForSubject(label.subjectKey),
    }
  }
}

/**
 * A fresh connection has no busy timeout, so a write that overlaps another
 * connection's write transaction fails at once with SQLITE_BUSY. A timeout
 * cannot help in-process: libsql calls are synchronous and would block the
 * event loop that the lock holder needs. Retry with a new connection instead.
 */
async function retryWhileBusy<T>(attempt: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + SQLITE_LOCK_WAIT_MS
  for (;;) {
    try {
      return await attempt()
    } catch (err) {
      const busy = (err as { code?: string }).code === 'SQLITE_BUSY'
      if (!busy || Date.now() >= deadline) throw err
      await new Promise((resolve) => setTimeout(resolve, 1 + Math.random() * 5))
    }
  }
}

type SqliteColumn = string | number | bigint | null

function toSqliteRow(row: Record<string, SqliteColumn>): LabelRow {
  return {
    seq: Number(row.seq),
    subjectKey: String(row.subjectKey),
    subjectKind: String(row.subjectKind),
    cid: row.cid === null ? null : String(row.cid),
    val: String(row.val),
    neg: Number(row.neg) !== 0,
    ref: row.ref === null ? null : String(row.ref),
    boundaries: String(row.boundaries),
    createdBy: String(row.createdBy),
    createdAt: String(row.createdAt),
  }
}

export class PgLabelStore implements LabelStore {
  constructor(private db: ServicePgDb) {}

  async latestForSubject(subjectKey: string): Promise<StoredLabel | undefined> {
    const [row] = await this.db
      .select()
      .from(pgModerationLabel)
      .where(eq(pgModerationLabel.subjectKey, subjectKey))
      .orderBy(desc(pgModerationLabel.seq))
      .limit(1)
    return row ? toStoredLabel(row) : undefined
  }

  async listFrom(opts: ListFromOptions): Promise<StoredLabel[]> {
    if (opts.subjects?.length === 0) return []
    const rows = await this.db
      .select()
      .from(pgModerationLabel)
      .where(
        and(
          gt(pgModerationLabel.seq, opts.cursor ?? 0),
          opts.upTo === undefined
            ? undefined
            : lte(pgModerationLabel.seq, opts.upTo),
          opts.subjects === undefined
            ? undefined
            : inArray(pgModerationLabel.subjectKey, opts.subjects),
        ),
      )
      .orderBy(asc(pgModerationLabel.seq))
      .limit(opts.limit)
    return rows.map(toStoredLabel)
  }

  async headSeq(): Promise<number> {
    const [row] = await this.db
      .select({ head: max(pgModerationLabel.seq) })
      .from(pgModerationLabel)
    return row?.head ?? 0
  }

  async appendIfLatest(
    expectedLatestSeq: number | null,
    label: NewLabel,
  ): Promise<AppendLabelResult> {
    return this.db.transaction(async (tx): Promise<AppendLabelResult> => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${LABEL_APPEND_LOCK_KEY})`,
      )

      const [latestRow] = await tx
        .select()
        .from(pgModerationLabel)
        .where(eq(pgModerationLabel.subjectKey, label.subjectKey))
        .orderBy(desc(pgModerationLabel.seq))
        .limit(1)
      const latest = latestRow ? toStoredLabel(latestRow) : undefined
      if (currentSeq(latest) !== expectedLatestSeq) {
        return { kind: 'stale', latest }
      }

      const [inserted] = await tx
        .insert(pgModerationLabel)
        .values(toInsertValues(label))
        .returning()
      return { kind: 'appended', label: toStoredLabel(inserted) }
    })
  }
}
