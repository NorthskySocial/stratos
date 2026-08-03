import type { Insertable, Selectable, Updateable } from 'kysely'

export interface StratosSyncCursorTable {
  did: string
  seq: number
  updatedAt: string
}

export type StratosSyncCursor = Selectable<StratosSyncCursorTable>
export type NewStratosSyncCursor = Insertable<StratosSyncCursorTable>
export type StratosSyncCursorUpdate = Updateable<StratosSyncCursorTable>

export interface StratosEnrollmentTable {
  did: string
  serviceUrl: string
  createdAt: string
  updatedAt: string
}

export interface StratosRecordTable {
  uri: string
  cid: string
  json: string
  indexedAt: string
}

export interface StratosRecordBoundaryTable {
  uri: string
  boundary: string
}

export interface PostTable {
  uri: string
  cid: string
  creator: string
  content: string
  createdAt: string
  indexedAt: string
}

export interface StratosBoundaryTable {
  did: string
  boundary: string
}

/**
 * The subset of the AppView database this indexer reads and writes. Declared
 * standalone rather than intersected with `@atproto/bsky`'s schema: bsky pins
 * kysely 0.22 while this package uses 0.28, so inferring its table map through
 * `Kysely<infer T>` silently yielded `never` and left every query untyped.
 */
export interface StratosIndexerSchema {
  stratos_sync_cursor: StratosSyncCursorTable
  stratos_enrollment: StratosEnrollmentTable
  stratos_boundary: StratosBoundaryTable
  stratos_record: StratosRecordTable
  stratos_record_boundary: StratosRecordBoundaryTable
  post: PostTable
}
