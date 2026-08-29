export * from './sqlite.js'
export * from './postgres.js'

import {
  enrolledActor,
  post,
  postBoundary,
  spaceSyncCursor,
  syncCursor,
} from './sqlite.js'
import {
  pgEnrolledActor,
  pgPost,
  pgPostBoundary,
  pgSpaceSyncCursor,
  pgSyncCursor,
} from './postgres.js'

export const sqliteSchema = {
  post,
  postBoundary,
  syncCursor,
  enrolledActor,
  spaceSyncCursor,
}

export const pgSchema = {
  post: pgPost,
  postBoundary: pgPostBoundary,
  syncCursor: pgSyncCursor,
  enrolledActor: pgEnrolledActor,
  spaceSyncCursor: pgSpaceSyncCursor,
}
