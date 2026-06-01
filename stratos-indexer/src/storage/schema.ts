import type { Insertable, Kysely, Selectable, Updateable } from 'kysely'
import type { DatabaseSchema } from '@atproto/bsky'

type DatabaseSchemaType = DatabaseSchema extends Kysely<infer T> ? T : never

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

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
export type StratosIndexerSchema = DatabaseSchemaType & {
  stratos_sync_cursor: StratosSyncCursorTable
  stratos_enrollment: StratosEnrollmentTable
  stratos_boundary: StratosBoundaryTable
  stratos_record: StratosRecordTable
  stratos_record_boundary: StratosRecordBoundaryTable
  post: PostTable
}
