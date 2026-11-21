import { StratosValidationError } from '../types.js'
import { POST_COLLECTION } from './post-rules.js'
import type { RecordRule } from './registry.js'
import { SUBJECT_ERROR_MESSAGE } from './subject.js'

const REPOST_COLLECTION = 'app.bsky.feed.repost'

export function createRepostRule(): RecordRule {
  return {
    collection: REPOST_COLLECTION,
    subject: { collections: [POST_COLLECTION] },
    check: (_record, input) => {
      if (input.subject?.eligible !== true) {
        throw new StratosValidationError(
          SUBJECT_ERROR_MESSAGE,
          'InvalidSubject',
        )
      }
    },
  }
}
