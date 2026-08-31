export * from './sqlite.js'
export * from './postgres.js'

import {
  enrolledActor,
  post,
  postBoundary,
  spaceMemberSnapshot,
  spaceSyncCursor,
  syncCursor,
} from './sqlite.js'
import {
  pgEnrolledActor,
  pgPost,
  pgPostBoundary,
  pgSpaceMemberSnapshot,
  pgSpaceSyncCursor,
  pgSyncCursor,
} from './postgres.js'

export const sqliteSchema = {
  post,
  postBoundary,
  syncCursor,
  enrolledActor,
  spaceSyncCursor,
  spaceMemberSnapshot,
}

export const pgSchema = {
  post: pgPost,
  postBoundary: pgPostBoundary,
  syncCursor: pgSyncCursor,
  enrolledActor: pgEnrolledActor,
  spaceSyncCursor: pgSpaceSyncCursor,
  spaceMemberSnapshot: pgSpaceMemberSnapshot,
}
