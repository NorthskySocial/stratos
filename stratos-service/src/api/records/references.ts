import {
  parseCanonicalRepoUri,
  parseCanonicalSpaceRecordUri,
  type RecordUri,
  type SubjectFacts,
} from '@northskysocial/stratos-core'
import type { AppContext } from '../../context.js'

const UNRESOLVABLE: SubjectFacts = { form: 'unresolvable' }

/**
 * Looks up the record a like or repost names, at this moment and outside any
 * lock. Every way the subject can be wrong, including a value that is not a
 * uri at all, answers `unresolvable`, so the caller can give one answer for
 * all of them and the write is no oracle for what exists.
 * @param subject - the record's `subject` value, as the client sent it
 */
export async function resolveReferencedRecord(
  ctx: AppContext,
  subject: unknown,
): Promise<SubjectFacts> {
  if (typeof subject !== 'object' || subject === null) return UNRESOLVABLE
  const { uri, cid } = subject as { uri?: unknown; cid?: unknown }
  if (typeof uri !== 'string') return UNRESOLVABLE
  if (cid !== undefined && typeof cid !== 'string') return UNRESOLVABLE

  const spaceRecord = parseCanonicalSpaceRecordUri(uri)
  if (spaceRecord) return resolveSpaceRecord(ctx, uri, spaceRecord)

  const repoRecord = parseCanonicalRepoUri(uri)
  if (repoRecord) return resolveRepoRecord(ctx, uri, repoRecord)

  return UNRESOLVABLE
}

async function resolveRepoRecord(
  ctx: AppContext,
  uri: string,
  parts: { author: string; collection: string },
): Promise<SubjectFacts> {
  // A read of a store that does not exist fails on sqlite and is unverified on
  // postgres, so the store is looked for first.
  if (!(await ctx.actorStore.exists(parts.author))) return UNRESOLVABLE

  const found = await ctx.actorStore.read(parts.author, (store) =>
    store.record.getVisibleRecordWithBoundaries(uri),
  )
  if (!found) return UNRESOLVABLE

  const enrollment = await ctx.enrollmentStore.getEnrollment(parts.author)
  if (!enrollment) return UNRESOLVABLE

  return {
    form: 'repo',
    uri,
    author: parts.author,
    collection: parts.collection,
    storedCid: found.record.cid,
    boundaries: found.boundaries,
    authorActive: enrollment.active,
    authorCustody: enrollment.custody ?? 'stratos',
  }
}

async function resolveSpaceRecord(
  ctx: AppContext,
  uri: string,
  parts: RecordUri,
): Promise<SubjectFacts> {
  const enrollment = await ctx.enrollmentStore.getEnrollment(parts.authorDid)
  if (!enrollment) return UNRESOLVABLE

  return {
    form: 'space',
    uri,
    authority: parts.spaceDid,
    spaceType: parts.spaceType,
    skey: parts.skey,
    author: parts.authorDid,
    collection: parts.collection,
    authorActive: enrollment.active,
    authorCustody: enrollment.custody ?? 'stratos',
    authorBoundaries: await ctx.enrollmentStore.getBoundaries(parts.authorDid),
  }
}
