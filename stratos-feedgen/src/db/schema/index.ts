export * from './sqlite.js'
export * from './postgres.js'

import {
  enrolledActor,
  post,
  postBoundary,
  spaceMemberSnapshot,
  spaceSyncStage,
  spaceSyncCursor,
  syncCursor,
} from './sqlite.js'
import {
  pgEnrolledActor,
  pgPost,
  pgPostBoundary,
  pgSpaceMemberSnapshot,
  pgSpaceSyncStage,
  pgSpaceSyncCursor,
  pgSyncCursor,
} from './postgres.js'

export const sqliteSchema = {
  post,
  postBoundary,
  syncCursor,
  enrolledActor,
  spaceSyncCursor,
  spaceSyncStage,
  spaceMemberSnapshot,
}

export const pgSchema = {
  post: pgPost,
  postBoundary: pgPostBoundary,
  syncCursor: pgSyncCursor,
  enrolledActor: pgEnrolledActor,
  spaceSyncCursor: pgSpaceSyncCursor,
  spaceSyncStage: pgSpaceSyncStage,
  spaceMemberSnapshot: pgSpaceMemberSnapshot,
}
