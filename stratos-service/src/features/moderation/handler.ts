import { InvalidRequestError, Server as XrpcServer } from '@atproto/xrpc-server'
import {
  decideLabelAction,
  spaceSubjectBoundary,
  labelSubjectKey,
  parseLabelSubject,
  takedownMarker,
  TAKEDOWN_VALUE,
  validateLabelValue,
  type LabelSubjectInput,
  type NewLabel,
  type ParsedLabelSubject,
  type StoredLabel,
} from '@northskysocial/stratos-core'
import type { AppContext } from '../../context-types.js'
import type { XrpcServerInternal } from '../../api/types.js'
import { createXrpcHandler } from '../../api/util.js'
import { applyEnrollmentHolds } from '../enrollment/index.js'
import { registerQueryLabelsHandler } from './query-handler.js'
import { toWireLabel } from './wire-label.js'

export const CREATE_LABEL_METHOD = 'zone.stratos.moderation.createLabel'

/** Non-empty stand-in until the label's seq is known; reconcile replaces it. */
export const PROVISIONAL_TAKEDOWN_MARKER = 'pending-label'

const MAX_APPEND_ATTEMPTS = 3
const MAX_RECONCILE_ROUNDS = 5

interface CreateLabelInput {
  subject: LabelSubjectInput
  val: string
  neg?: boolean
  ref?: string
}

type HostedRecordSubject = Extract<
  ParsedLabelSubject,
  { kind: 'hosted-record' }
>

type SpaceRecordSubject = Extract<ParsedLabelSubject, { kind: 'space-record' }>

type AccountSubject = Extract<ParsedLabelSubject, { kind: 'account' }>

interface LabelRequestContext {
  ctx: AppContext
  subject: HostedRecordSubject | SpaceRecordSubject | AccountSubject
  subjectKey: string
  callerDid: string
  neg: boolean
  ref: string | undefined
  boundaries: string[]
  /** A hosted or account takedown hides the subject before the append; space records have nothing to hide. */
  beforeAppend?: () => Promise<void>
}

/** createLabel binds `moderationService` only; no other credential type is admitted. */
export function registerModerationHandlers(
  server: XrpcServer,
  ctx: AppContext,
): void {
  const xrpc = server as unknown as XrpcServerInternal

  xrpc.method(CREATE_LABEL_METHOD, {
    type: 'procedure',
    auth: ctx.authVerifier.moderationService,
    handler: createXrpcHandler<CreateLabelInput>(ctx, CREATE_LABEL_METHOD, {
      // createXrpcHandler types `did` as optional but rejects a missing one first.
      handler: async ({ input, did }) =>
        handleCreateLabel(ctx, input, did as string),
    }),
  })

  registerQueryLabelsHandler(xrpc, ctx)
}

async function handleCreateLabel(
  ctx: AppContext,
  input: CreateLabelInput,
  callerDid: string,
): Promise<{ label?: Record<string, unknown> }> {
  const value = validateLabelValue(input.val)
  if (!value.ok) throw new InvalidRequestError(value.error.message)
  const parsed = parseLabelSubject(input.subject)
  if (!parsed.ok) throw new InvalidRequestError(parsed.error.message)
  const neg = input.neg === true
  switch (parsed.value.kind) {
    case 'hosted-record':
      return handleHostedLabel(ctx, parsed.value, input, callerDid, neg)
    case 'space-record':
      return handleSpaceLabel(ctx, parsed.value, input, callerDid, neg)
    case 'account':
      return handleAccountLabel(ctx, parsed.value, input, callerDid, neg)
  }
}

async function handleHostedLabel(
  ctx: AppContext,
  subject: HostedRecordSubject,
  input: CreateLabelInput,
  callerDid: string,
  neg: boolean,
): Promise<{ label?: Record<string, unknown> }> {
  const boundaries = await readStoredBoundaries(ctx, subject)
  const ref = input.ref
  const hideBeforeAppend = () =>
    setMarker(ctx, subject, {
      applied: true,
      ref: ref || PROVISIONAL_TAKEDOWN_MARKER,
    })
  const request: LabelRequestContext = {
    ctx,
    subject,
    subjectKey: labelSubjectKey(subject),
    callerDid,
    neg,
    ref,
    boundaries,
    // A takedown hides first so a failed append leaves the record hidden. A
    // negation appends first and the reconcile clears the marker, so a failed
    // negation also leaves it hidden.
    ...(neg ? {} : { beforeAppend: hideBeforeAppend }),
  }

  const label = await writeLabel(request)
  await reconcileMarker(ctx, subject, request.subjectKey)
  return label ? { label: toWireLabel(label) } : {}
}

async function handleSpaceLabel(
  ctx: AppContext,
  subject: SpaceRecordSubject,
  input: CreateLabelInput,
  callerDid: string,
  neg: boolean,
): Promise<{ label?: Record<string, unknown> }> {
  const mapped = spaceSubjectBoundary(subject.record, ctx.serviceDid)
  if (!mapped.ok) throw new InvalidRequestError(mapped.error.message)
  const boundary = mapped.value
  if (!(await ctx.boundaryStore?.get(boundary))) {
    throw new InvalidRequestError('unknown boundary')
  }

  const subjectKey = labelSubjectKey(subject)
  const latest = await ctx.labelStore.latestForSubject(subjectKey)
  const takedownInForce = latest !== undefined && !latest.neg
  const authorEnrollment = await ctx.enrollmentStore.getEnrollment(
    subject.record.authorDid,
  )
  // Only the repo-form URI writes the marker that hides a hosted record, so a
  // space-form label would record a takedown that hides nothing.
  if (
    authorEnrollment &&
    (authorEnrollment.custody ?? 'stratos') === 'stratos'
  ) {
    throw new InvalidRequestError(
      'records of this author are hosted by Stratos; use the repo-form URI',
    )
  }
  if (!(neg && takedownInForce)) {
    await assertAuthorHoldsBoundary(
      ctx,
      subject.record.authorDid,
      authorEnrollment,
      boundary,
    )
  }

  const label = await writeLabel({
    ctx,
    subject,
    subjectKey,
    callerDid,
    neg,
    ref: input.ref,
    boundaries: [boundary],
  })
  return label ? { label: toWireLabel(label) } : {}
}

async function handleAccountLabel(
  ctx: AppContext,
  subject: AccountSubject,
  input: CreateLabelInput,
  callerDid: string,
  neg: boolean,
): Promise<{ label?: Record<string, unknown> }> {
  const enrollment = await ctx.enrollmentStore.getEnrollment(subject.did)
  if (!enrollment) throw subjectAccountNotFound()
  if (enrollment.isService) {
    throw new InvalidRequestError(
      'account subject must be a member, not a service',
    )
  }

  const deactivateMember = async () => {
    const holds = await applyEnrollmentHolds(ctx, subject.did, {
      takedownHold: true,
    })
    // The row can vanish after the existence check, for example a concurrent
    // unenroll. Appending then would label a DID with no enrollment.
    if (!holds) throw subjectAccountNotFound()
  }
  // A takedown deactivates first so a failed append leaves the member
  // inactive. The recompute runs last and reads the stored operator hold, so a
  // negation never lifts one. A failed append skips it and a repeat finishes.
  const label = await writeLabel({
    ctx,
    subject,
    subjectKey: labelSubjectKey(subject),
    callerDid,
    neg,
    ref: input.ref,
    boundaries: [],
    ...(neg ? {} : { beforeAppend: deactivateMember }),
  })
  await applyEnrollmentHolds(ctx, subject.did, {})
  return label ? { label: toWireLabel(label) } : {}
}

function subjectAccountNotFound(): InvalidRequestError {
  return new InvalidRequestError('Subject account not found', 'SubjectNotFound')
}

/** The author, never the authority: only a member's own records can be labelled. */
async function assertAuthorHoldsBoundary(
  ctx: AppContext,
  authorDid: string,
  enrollment: { active: boolean } | null | undefined,
  boundary: string,
): Promise<void> {
  // The reserved all-members domain is added for any DID, so it proves nothing
  // without an active enrollment. Same check as space-credential.
  const held = enrollment?.active
    ? await ctx.enrollmentStore.getBoundaries(authorDid)
    : []
  if (!held.includes(boundary)) {
    throw new InvalidRequestError('author is not a member of the boundary')
  }
}

/**
 * Fails with `SubjectNotFound` unless the record exists, taken down or not,
 * so a negation can find it. Boundaries come from the stored rows, never from
 * the record body, which is only a claim.
 */
async function readStoredBoundaries(
  ctx: AppContext,
  subject: HostedRecordSubject,
): Promise<string[]> {
  const notFound = () =>
    new InvalidRequestError('Subject record not found', 'SubjectNotFound')
  if (!(await ctx.actorStore.exists(subject.authorDid))) throw notFound()

  const boundaries = await ctx.actorStore.read(
    subject.authorDid,
    async (store) => {
      if (!(await store.record.hasRecord(subject.uri, null, true))) return null
      return store.record.getRecordBoundaries(subject.uri)
    },
  )
  if (boundaries === null) throw notFound()
  if (boundaries.length === 0) {
    ctx.logger?.warn(
      { subject: subject.uri },
      'labelling a record with no stored boundaries',
    )
  }
  return boundaries
}

/**
 * For a hosted takedown `beforeAppend` runs before the label, so a failed
 * append leaves the record hidden; a repeat then finishes the job.
 */
async function writeLabel(
  request: LabelRequestContext,
): Promise<StoredLabel | undefined> {
  const { ctx, subject, subjectKey, callerDid, neg, ref, boundaries } = request
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    const latest = await ctx.labelStore.latestForSubject(subjectKey)
    const decision = decideLabelAction(latest, { neg, ref })
    if (decision.kind === 'return-existing') return decision.label
    if (decision.kind === 'no-change') return undefined

    await request.beforeAppend?.()
    const newLabel: NewLabel = {
      subjectKey,
      subjectKind: subject.kind === 'account' ? 'account' : 'record',
      ...(subject.kind === 'account' || subject.cid === undefined
        ? {}
        : { cid: subject.cid }),
      val: TAKEDOWN_VALUE,
      neg,
      ...(ref ? { ref } : {}),
      boundaries,
      createdBy: callerDid,
      createdAt: new Date().toISOString(),
    }
    const result = await ctx.labelStore.appendIfLatest(
      latest?.seq ?? null,
      newLabel,
    )
    if (result.kind === 'appended') {
      ctx.logger?.info(
        {
          subject: subjectKey,
          callerDid,
          neg,
          ref: result.label.ref,
          seq: result.label.seq,
        },
        'moderation label appended',
      )
      return result.label
    }
  }
  ctx.logger?.warn(
    { subject: subjectKey, attempts: MAX_APPEND_ATTEMPTS },
    'moderation label append kept losing to concurrent appends',
  )
  throw new Error('Could not append label: too many concurrent updates')
}

/**
 * Sets the marker from the subject's latest label. It repeats until the latest
 * label is unchanged after the write, so a concurrent append cannot leave this
 * request's older view as the final marker.
 */
async function reconcileMarker(
  ctx: AppContext,
  subject: HostedRecordSubject,
  subjectKey: string,
): Promise<void> {
  let latest = await ctx.labelStore.latestForSubject(subjectKey)
  for (let round = 0; round < MAX_RECONCILE_ROUNDS; round++) {
    await setMarker(
      ctx,
      subject,
      latest && !latest.neg
        ? { applied: true, ref: takedownMarker(latest) }
        : { applied: false },
    )
    const after = await ctx.labelStore.latestForSubject(subjectKey)
    if (after?.seq === latest?.seq) return
    latest = after
  }
  ctx.logger?.warn(
    { subject: subjectKey },
    'moderation marker reconcile gave up while labels kept changing',
  )
}

async function setMarker(
  ctx: AppContext,
  subject: HostedRecordSubject,
  takedown: { applied: boolean; ref?: string },
): Promise<void> {
  const unlock = await ctx.repoWriteLocks.acquire(subject.authorDid)
  try {
    await ctx.actorStore.transact(subject.authorDid, (store) =>
      store.record.updateRecordTakedown(subject.uri, takedown),
    )
  } finally {
    unlock()
  }
}
