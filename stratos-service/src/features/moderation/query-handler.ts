import { InvalidRequestError } from '@atproto/xrpc-server'
import {
  labelVisibleToService,
  logQueryCursor,
  parseLabelCursor,
  parseSubjectFilter,
  subjectQueryCursor,
  type StoredLabel,
} from '@northskysocial/stratos-core'
import type { AppContext } from '../../context-types.js'
import type { HandlerAuth, XrpcServerInternal } from '../../api/types.js'
import { createXrpcHandler } from '../../api/util.js'
import {
  requireServiceCaller,
  resolveEffectiveBoundaries,
} from '../../infra/auth/credential-scope.js'
import { toWireLabel } from './wire-label.js'

export const QUERY_LABELS_METHOD = 'zone.stratos.moderation.queryLabels'

const DEFAULT_LIMIT = 50

/** Rows a scoped log query may examine, so a log of invisible labels cannot hold a request open. */
const SCAN_MAX = 1000

interface QueryLabelsParams {
  cursor?: string
  limit?: number
  subjects?: string[]
}

interface LabelQuery {
  cursor: number
  limit: number
  subjects: string[] | undefined
}

interface LabelPage {
  cursor: string
  labels: StoredLabel[]
  scanned: number
}

export function registerQueryLabelsHandler(
  xrpc: XrpcServerInternal,
  ctx: AppContext,
): void {
  xrpc.method(QUERY_LABELS_METHOD, {
    type: 'query',
    auth: ctx.authVerifier.moderationServiceOrService,
    handler: createXrpcHandler<unknown, QueryLabelsParams>(
      ctx,
      QUERY_LABELS_METHOD,
      {
        handler: async ({ params, auth, did }) => {
          const query = parseQuery(params)
          const page = isModerationCaller(auth)
            ? await readAsModerationService(ctx, query)
            : await readAsEnrolledService(ctx, query, auth)
          ctx.logger?.debug(
            {
              callerDid: did,
              returned: page.labels.length,
              scanned: page.scanned,
            },
            'moderation labels queried',
          )
          return { cursor: page.cursor, labels: page.labels.map(toWireLabel) }
        },
      },
    ),
  })
}

function isModerationCaller(auth: HandlerAuth | undefined): boolean {
  return auth?.credentials?.type === 'moderation-service'
}

function parseQuery(params: QueryLabelsParams): LabelQuery {
  const cursor = parseLabelCursor(params.cursor)
  if (!cursor.ok) throw new InvalidRequestError(cursor.error.message)
  const subjects = parseSubjectFilter(params.subjects)
  if (!subjects.ok) throw new InvalidRequestError(subjects.error.message)
  return {
    cursor: cursor.value,
    limit: params.limit ?? DEFAULT_LIMIT,
    subjects: subjects.value,
  }
}

async function readAsModerationService(
  ctx: AppContext,
  query: LabelQuery,
): Promise<LabelPage> {
  const { cursor, limit, subjects } = query
  const head = subjects === undefined ? 0 : await ctx.labelStore.headSeq()
  const labels = await ctx.labelStore.listFrom({
    cursor,
    limit,
    ...(subjects === undefined ? {} : { upTo: head, subjects }),
  })
  return {
    cursor:
      subjects === undefined
        ? logQueryCursor(cursor, labels.at(-1)?.seq)
        : subjectPageCursor(cursor, labels, limit, head),
    labels,
    scanned: labels.length,
  }
}

async function readAsEnrolledService(
  ctx: AppContext,
  query: LabelQuery,
  auth: HandlerAuth | undefined,
): Promise<LabelPage> {
  // Only plain service auth reaches here; the check keeps any other credential
  // type from being treated as an enrolled service.
  requireServiceCaller(auth)
  // Rejects a missing or deactivated enrollment and an empty boundary set.
  const caller = [...(await resolveEffectiveBoundaries(ctx, auth))]
  return query.subjects === undefined
    ? scanLog(ctx, query, caller)
    : scanSubjects(ctx, { ...query, subjects: query.subjects }, caller)
}

/** A full page resumes after its last label; any other page resumes at the head. */
function subjectPageCursor(
  inputCursor: number,
  labels: StoredLabel[],
  limit: number,
  head: number,
): string {
  return labels.length === limit
    ? String(labels[labels.length - 1].seq)
    : subjectQueryCursor(inputCursor, head)
}

/**
 * One enrollment lookup and one boundary lookup per distinct member per batch.
 * An account label follows the member's current boundaries, whether or not the
 * member is still active. A member with no enrollment row has no boundaries to
 * share: the store adds the reserved all-members boundary to every DID it is
 * asked about, so asking for the boundaries alone would show the label of an
 * unenrolled DID to every service.
 */
async function loadMemberBoundaries(
  ctx: AppContext,
  batch: StoredLabel[],
): Promise<Map<string, string[] | undefined>> {
  const members = [
    ...new Set(
      batch
        .filter((label) => label.subjectKind === 'account')
        .map((label) => label.subjectKey),
    ),
  ]
  const entries = await Promise.all(
    members.map(async (did) => {
      const enrollment = await ctx.enrollmentStore.getEnrollment(did)
      if (enrollment === null) return [did, undefined] as const
      return [did, await ctx.enrollmentStore.getBoundaries(did)] as const
    }),
  )
  return new Map(entries)
}

async function visibleIn(
  ctx: AppContext,
  batch: StoredLabel[],
  caller: string[],
): Promise<(label: StoredLabel) => boolean> {
  const members = await loadMemberBoundaries(ctx, batch)
  return (label) =>
    labelVisibleToService(label, caller, members.get(label.subjectKey))
}

async function scanLog(
  ctx: AppContext,
  query: LabelQuery,
  caller: string[],
): Promise<LabelPage> {
  const { limit } = query
  const labels: StoredLabel[] = []
  let position = query.cursor
  let lastScanned: number | undefined
  let scanned = 0
  while (labels.length < limit && scanned < SCAN_MAX) {
    const batchSize = Math.min(limit, SCAN_MAX - scanned)
    const batch = await ctx.labelStore.listFrom({
      cursor: position,
      limit: batchSize,
    })
    const isVisible = await visibleIn(ctx, batch, caller)
    for (const label of batch) {
      scanned++
      lastScanned = label.seq
      if (isVisible(label)) labels.push(label)
      if (labels.length === limit) break
    }
    if (batch.length < batchSize) break
    position = batch[batch.length - 1].seq
  }
  return {
    cursor: logQueryCursor(query.cursor, lastScanned),
    labels,
    scanned,
  }
}

/**
 * Reads the named subjects up to the head taken at the start. An out-of-scope
 * subject and a never-labelled subject get identical responses. The subject
 * list bounds the scan; SCAN_MAX does not apply.
 */
async function scanSubjects(
  ctx: AppContext,
  query: LabelQuery & { subjects: string[] },
  caller: string[],
): Promise<LabelPage> {
  const { limit, subjects } = query
  const head = await ctx.labelStore.headSeq()
  const labels: StoredLabel[] = []
  let position = query.cursor
  let scanned = 0
  while (labels.length < limit) {
    const batch = await ctx.labelStore.listFrom({
      cursor: position,
      limit,
      upTo: head,
      subjects,
    })
    const isVisible = await visibleIn(ctx, batch, caller)
    for (const label of batch) {
      scanned++
      if (isVisible(label)) labels.push(label)
      if (labels.length === limit) break
    }
    if (batch.length < limit) break
    position = batch[batch.length - 1].seq
  }
  return {
    cursor: subjectPageCursor(query.cursor, labels, limit, head),
    labels,
    scanned,
  }
}
