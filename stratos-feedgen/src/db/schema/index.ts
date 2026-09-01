export * from './sqlite.js'
export * from './postgres.js'

import {
  enrolledActor,
  post,
  postBoundary,
  spaceMemberSnapshot,
  spaceSyncPendingVerification,
  spaceSyncStage,
  spaceSyncCursor,
  syncCursor,
} from './sqlite.js'
import {
  pgEnrolledActor,
  pgPost,
  pgPostBoundary,
  pgSpaceMemberSnapshot,
  pgSpaceSyncPendingVerification,
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
  spaceSyncPendingVerification,
  spaceMemberSnapshot,
}

export const pgSchema = {
  post: pgPost,
  postBoundary: pgPostBoundary,
  syncCursor: pgSyncCursor,
  enrolledActor: pgEnrolledActor,
  spaceSyncCursor: pgSpaceSyncCursor,
  spaceSyncStage: pgSpaceSyncStage,
  spaceSyncPendingVerification: pgSpaceSyncPendingVerification,
  spaceMemberSnapshot: pgSpaceMemberSnapshot,
}
