import { sql, SQL } from 'drizzle-orm'

/**
 * Reference type for dynamic SQL
 */
export type DbRef = SQL

/**
 * Check if a record is soft-deleted
 */
export const softDeleted = (record: {
  takedownRef: string | null
}): boolean => {
  return record.takedownRef !== null
}

/**
 * SQL count(*) expression
 */
export const countAll = sql<number>`count(*)`

/**
 * SQL count(distinct ref) expression
 */
export const countDistinct = (ref: DbRef): SQL<number> =>
  sql<number>`count(distinct ${ref})`
