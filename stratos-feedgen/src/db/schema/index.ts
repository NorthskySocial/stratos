export * from './sqlite.js'
export * from './postgres.js'

import { enrolledActor, post, postBoundary, syncCursor } from './sqlite.js'
import {
  pgEnrolledActor,
  pgPost,
  pgPostBoundary,
  pgSyncCursor,
} from './postgres.js'

export const sqliteSchema = {
  post,
  postBoundary,
  syncCursor,
  enrolledActor,
}

export const pgSchema = {
  post: pgPost,
  postBoundary: pgPostBoundary,
  syncCursor: pgSyncCursor,
  enrolledActor: pgEnrolledActor,
}
