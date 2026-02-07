import { sql, SQL } from 'drizzle-orm'

/**
 * Reference type for dynamic SQL
 */
export type DbRef = SQL<unknown>

/**
 * Check if a record is soft-deleted
 */
export const softDeleted = (record: { takedownRef: string | null }) => {
  return record.takedownRef !== null
}

/**
 * SQL count(*) expression
 */
export const countAll = sql<number>`count(*)`

/**
 * SQL count(distinct ref) expression
 */
export const countDistinct = (ref: DbRef) => sql<number>`count(distinct ${ref})`
