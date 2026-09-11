import type {
  GeneratedAlways,
  Insertable,
  Selectable,
  Updateable,
} from 'kysely'

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
  enrolledAt: string
  lastChecked: string
  boundaries: string | null
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
  text: string
  createdAt: string
  indexedAt: string
  sortAt: GeneratedAlways<string>
}

/**
 * The subset of the AppView database this indexer reads and writes. Declared
 * standalone so query types do not depend on the AppView's Kysely version.
 */
export interface StratosIndexerSchema {
  stratos_sync_cursor: StratosSyncCursorTable
  stratos_enrollment: StratosEnrollmentTable
  stratos_record: StratosRecordTable
  stratos_record_boundary: StratosRecordBoundaryTable
  post: PostTable
}
