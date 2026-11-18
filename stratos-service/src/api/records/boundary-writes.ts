import { InvalidRequestError } from '@atproto/xrpc-server'
import { TID } from '@atproto/common-web'
import { AtUri as AtUriSyntax } from '@atproto/syntax'
import type { Cid } from '@atproto/lex-data'
import {
  buildCommit,
  computeCid,
  encodeRecord,
  getStratosBacklinks,
  type MstWriteOp,
  parseCid,
  StratosValidator,
} from '@northskysocial/stratos-core'
import type { ActorTransactor } from '../../actor-store-types.js'
import type { AppContext } from '../../context.js'
import type { ActorSignFn } from '../../infra/signing/actor-signer.js'
import { signAndPersistCommit, StratosBlockStoreReader } from '../../features'
import {
  assertStratosCustody,
  assertWritableEnrollment,
  assertWriterStillAuthorized,
} from './custody.js'
import {
  type BatchWriteResult,
  type CommitResult,
  opBoundary,
  sequenceChange,
  type SequenceTrace,
} from './types.js'
import {
  assertRecordTypeMatches,
  type LexiconCheck,
  type LexiconValidationStatus,
  skipLexiconValidation,
  validateIfKnown,
} from './lexicon-validation.js'
import { assertCollectionGranted } from './scope-check.js'
import { ensureActorStoreExists } from './util.js'
import {
  assertCollectionInHostedSpaceType,
  assertSubjectWellFormed,
  authorizeBoundary,
  validateRecordInBoundary,
  assertBoundaryInCatalog,
  recordRulesFor,
  withConcurrencyRetry,
} from './validation.js'

const DOMAINS_TYPE = 'zone.stratos.boundary.defs#Domains'

export { assertRecordTypeMatches }

export type BoundaryWrite =
  | { kind: 'create'; collection: string; rkey?: string; record: unknown }
  | { kind: 'put'; collection: string; rkey: string; record: unknown }
  | { kind: 'update'; collection: string; rkey: string; record: unknown }
  | { kind: 'delete'; collection: string; rkey: string }

export type BoundaryDeleteOutcome =
  | { deleted: true; commit: CommitResult['commit'] }
  | { deleted: false }

type KeyedWrite = BoundaryWrite & { rkey: string }

interface PreparedDelete {
  kind: 'delete'
  collection: string
  rkey: string
  uri: string
}

interface PreparedRecordWrite {
  kind: 'create' | 'put' | 'update'
  collection: string
  rkey: string
  uri: string
  record: Record<string, unknown>
  recordBytes: Uint8Array
  cid: Cid
  tempRev: string
  validationStatus?: LexiconValidationStatus
}

type PreparedWrite = PreparedDelete | PreparedRecordWrite

type PlannedAction = 'create' | 'update' | 'delete'

type PlannedWrite = PreparedWrite & {
  action: PlannedAction
  /** The boundaries the record is stored in before this write. */
  storedBoundaries: string[]
}

interface StoredRecordState {
  exists: boolean
  takenDown: boolean
  boundaries: string[]
}

/**
 * Decides what a write does to the record the transaction found. It throws
 * when the write is refused, and returns null when the write has nothing to do.
 */
type WritePlanner = (
  write: PreparedWrite,
  stored: StoredRecordState,
  boundary: string,
) => PlannedAction | null

/**
 * Checks that a record's own boundary claim, if it makes one, is exactly the
 * boundary the request names. The stored boundary always comes from the
 * request, so a claim can only agree or be refused.
 * @throws InvalidRequestError `BoundaryMismatch` when the claim is anything else
 */
export function assertBodyBoundaryMatches(
  record: unknown,
  boundary: string,
): asserts record is Record<string, unknown> {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new InvalidRequestError('Record must be an object', 'InvalidRecord')
  }
  const claimed = (record as Record<string, unknown>).boundary
  if (claimed === undefined) return
  if (!isSingleBoundaryClaim(claimed, boundary)) {
    throw new InvalidRequestError(
      'The record boundary does not match the boundary of the request',
      'BoundaryMismatch',
    )
  }
}

function isSingleBoundaryClaim(claimed: unknown, boundary: string): boolean {
  if (typeof claimed !== 'object' || claimed === null) return false
  const { $type, values, ...rest } = claimed as Record<string, unknown>
  if (Object.keys(rest).length > 0) return false
  if ($type !== undefined && $type !== DOMAINS_TYPE) return false
  if (!Array.isArray(values) || values.length !== 1) return false
  const [entry] = values as unknown[]
  if (typeof entry !== 'object' || entry === null) return false
  const { value, ...entryRest } = entry as Record<string, unknown>
  return Object.keys(entryRest).length === 0 && value === boundary
}

/**
 * Applies writes to one boundary of the caller's repo as a single commit.
 * Every write is judged against the rows stored for its key inside the commit
 * transaction; any refusal stores and sequences nothing. Records are taken in
 * lex form, as the XRPC server delivers them, so blobs are `BlobRef` instances.
 * @param lexiconCheck - how each record's lexicon is checked; known lexicons by default
 * @throws InvalidRequestError for every refusal, named per rule
 */
export async function applyBoundaryWrites(
  ctx: AppContext,
  callerDid: string,
  boundary: string,
  writes: BoundaryWrite[],
  lexiconCheck: LexiconCheck = validateIfKnown,
): Promise<CommitResult> {
  const committed = await runBoundaryWrites(
    ctx,
    callerDid,
    boundary,
    writes,
    planBatchWrite,
    lexiconCheck,
  )
  if (!committed) {
    throw new Error('A batch write was planned as a no-op')
  }
  return committed
}

/**
 * Deletes one record from a boundary. A record that is missing, or that is
 * not stored in exactly this boundary, is reported as not deleted without a
 * commit or an event, so the two cases cannot be told apart.
 */
export async function deleteRecordInBoundary(
  ctx: AppContext,
  callerDid: string,
  boundary: string,
  collection: string,
  rkey: string,
): Promise<BoundaryDeleteOutcome> {
  const committed = await runBoundaryWrites(
    ctx,
    callerDid,
    boundary,
    [{ kind: 'delete', collection, rkey }],
    planSingleDelete,
    skipLexiconValidation,
  )
  return committed
    ? { deleted: true, commit: committed.commit }
    : { deleted: false }
}

async function runBoundaryWrites(
  ctx: AppContext,
  callerDid: string,
  boundary: string,
  writes: BoundaryWrite[],
  plan: WritePlanner,
  lexiconCheck: LexiconCheck,
): Promise<CommitResult | null> {
  if (writes.length === 0) {
    throw new InvalidRequestError('At least one write is required')
  }
  const sequenceTrace: SequenceTrace = { queuedAtMs: Date.now() }

  ctx.writeRateLimiter.assertWriteAllowed(callerDid, writes.length)
  for (const write of writes) {
    assertCollectionInHostedSpaceType(write.collection)
  }
  const keyed = assignRecordKeys(writes)
  assertNoDuplicateKeys(keyed, callerDid)

  const enrollment = await ctx.enrollmentStore.getEnrollment(callerDid)
  assertWritableEnrollment(enrollment)
  assertStratosCustody(enrollment)
  await authorizeBoundary(ctx, callerDid, boundary)
  await assertBoundaryInCatalog(ctx, boundary)

  const subjectCollections = collectionsNamingASubject(ctx)
  await assertInteractionsGranted(ctx, callerDid, writes, subjectCollections)
  const prepared = await prepareWrites(
    ctx,
    callerDid,
    boundary,
    keyed,
    lexiconCheck,
    subjectCollections,
  )
  const actorSign = await ctx.actorSigner.getSignFn(callerDid)

  const unlock = await ctx.repoWriteLocks.acquire(callerDid)
  let committed: CommitResult | null
  try {
    await assertWriterStillAuthorized(ctx, callerDid, boundary)
    await assertBoundaryInCatalog(ctx, boundary)
    await ensureActorStoreExists(ctx.actorStore, callerDid)

    const retry = await withConcurrencyRetry(
      () =>
        ctx.actorStore.transact(callerDid, (store) =>
          commitPlannedWrites(
            store,
            callerDid,
            boundary,
            prepared,
            plan,
            actorSign,
            sequenceTrace,
            subjectCollections,
          ),
        ),
      ctx.logger,
    )
    committed = retry.result
  } finally {
    unlock()
  }

  if (committed) ctx.sequenceEvents.emit(callerDid)
  return committed
}

function assignRecordKeys(writes: BoundaryWrite[]): KeyedWrite[] {
  return writes.map((write) =>
    write.kind === 'create' && write.rkey === undefined
      ? { ...write, rkey: TID.nextStr() }
      : (write as KeyedWrite),
  )
}

function assertNoDuplicateKeys(writes: KeyedWrite[], callerDid: string): void {
  const seen = new Set<string>()
  for (const { collection, rkey } of writes) {
    const uri = `at://${callerDid}/${collection}/${rkey}`
    if (seen.has(uri)) {
      throw new InvalidRequestError(
        `More than one write targets ${collection}/${rkey}`,
      )
    }
    seen.add(uri)
  }
}

/** The collections whose records name a subject, of which a member keeps one per subject. */
function collectionsNamingASubject(ctx: AppContext): ReadonlySet<string> {
  const rules = [...recordRulesFor(ctx.cfg.stratos).values()]
  return new Set(
    rules.filter((rule) => rule.subject).map((rule) => rule.collection),
  )
}

/** Posts are not checked: some members' grants never covered them. */
async function assertInteractionsGranted(
  ctx: AppContext,
  callerDid: string,
  writes: BoundaryWrite[],
  subjectCollections: ReadonlySet<string>,
): Promise<void> {
  const written = writes
    .filter((write) => write.kind !== 'delete')
    .map((write) => write.collection)
  for (const collection of new Set(written)) {
    if (subjectCollections.has(collection)) {
      await assertCollectionGranted(ctx, callerDid, collection)
    }
  }
}

/** Validation and encoding that need no lock; deletes carry no record. */
async function prepareWrites(
  ctx: AppContext,
  callerDid: string,
  boundary: string,
  writes: KeyedWrite[],
  lexiconCheck: LexiconCheck,
  subjectCollections: ReadonlySet<string>,
): Promise<PreparedWrite[]> {
  for (const write of writes) {
    if (write.kind !== 'delete') {
      assertBodyBoundaryMatches(write.record, boundary)
      assertRecordTypeMatches(write.record, write.collection)
    }
  }
  // Every write settles and the refusal of the lowest index is reported, so the
  // answer does not depend on which lookup happens to finish first. Running
  // them one by one instead would add up to 200 sequential reads.
  const settled = await Promise.allSettled(
    writes.map(async (write): Promise<PreparedWrite> => {
      const uri = new AtUriSyntax(
        `at://${callerDid}/${write.collection}/${write.rkey}`,
      ).toString()
      if (write.kind === 'delete') {
        return {
          kind: 'delete',
          collection: write.collection,
          rkey: write.rkey,
          uri,
        }
      }
      const record = write.record as Record<string, unknown>
      if (subjectCollections.has(write.collection)) {
        assertSubjectWellFormed(record)
      }
      // The lexicon check comes first so the rules only see a well-formed record.
      const validationStatus = lexiconCheck(write.collection, record)
      await validateRecordInBoundary(ctx, write.collection, record, boundary)
      return {
        kind: write.kind,
        collection: write.collection,
        rkey: write.rkey,
        uri,
        record,
        ...(await encodeForStorage(write.collection, record)),
        tempRev: TID.nextStr(),
        validationStatus,
      }
    }),
  )
  const prepared = settled.map((outcome) => {
    if (outcome.status === 'rejected') throw outcome.reason
    return outcome.value
  })
  assertNoDuplicateSubjects(prepared, subjectCollections)
  return prepared
}

/**
 * Refuses a batch that names one subject twice in one collection. The stored
 * rows the transaction compares against cannot show it, because the batch is
 * indexed only after every write is planned.
 */
function assertNoDuplicateSubjects(
  writes: PreparedWrite[],
  subjectCollections: ReadonlySet<string>,
): void {
  const seen = new Set<string>()
  for (const write of writes) {
    if (write.kind === 'delete' || !subjectCollections.has(write.collection)) {
      continue
    }
    for (const { path, linkTo } of getStratosBacklinks(
      write.uri,
      write.record,
    )) {
      const key = JSON.stringify([write.collection, path, linkTo])
      if (seen.has(key)) throw interactionAlreadyExists()
      seen.add(key)
    }
  }
}

/**
 * Encodes a record to the bytes and CID that are stored. The encoder throws
 * plain errors for values the data model forbids, such as fractions, which the
 * caller sent and must hear about as a refusal of the record.
 */
async function encodeForStorage(
  collection: string,
  record: Record<string, unknown>,
): Promise<{ recordBytes: Uint8Array; cid: Cid }> {
  try {
    return {
      recordBytes: encodeRecord(record),
      cid: await computeCid(record),
    }
  } catch {
    throw new InvalidRequestError(
      `Invalid ${collection} record: the record cannot be encoded`,
      'InvalidRecord',
    )
  }
}

async function commitPlannedWrites(
  store: ActorTransactor,
  callerDid: string,
  boundary: string,
  prepared: PreparedWrite[],
  plan: WritePlanner,
  actorSign: ActorSignFn,
  sequenceTrace: SequenceTrace,
  subjectCollections: ReadonlySet<string>,
): Promise<CommitResult | null> {
  // The root lock comes first: every stored-state read below and the writes
  // after it then belong to one serialized step of this repo.
  const currentRoot = await store.repo.lockRoot()

  const planned: PlannedWrite[] = []
  for (const write of prepared) {
    const stored = await readStoredState(store, write.uri)
    const action = plan(write, stored, boundary)
    if (action) {
      planned.push({ ...write, action, storedBoundaries: stored.boundaries })
    }
  }
  if (planned.length === 0) return null
  await assertNoSubjectConflicts(store, planned, subjectCollections)

  const rootCid = currentRoot?.cid ? parseCid(currentRoot.cid).toString() : null
  const unsigned = await buildCommit(
    new StratosBlockStoreReader(store.repo),
    rootCid,
    { did: callerDid, writes: planned.map(toMstWriteOp) },
  )
  for (const write of planned) {
    if (write.kind !== 'delete') {
      await store.repo.putBlock(write.cid, write.recordBytes, write.tempRev)
    }
  }
  const commit = await signAndPersistCommit(store.repo, actorSign, unsigned)
  const commitCid = commit.commitCid.toString()

  const results: BatchWriteResult[] = []
  for (const write of planned) {
    results.push(await applyPlannedWrite(store, write, boundary, commit.rev))
  }
  for (const write of planned) {
    await sequencePlannedWrite(
      store,
      write,
      boundary,
      commitCid,
      commit.rev,
      sequenceTrace,
    )
  }
  return { results, commit: { cid: commitCid, rev: commit.rev } }
}

/**
 * A member keeps one like and one repost per subject. The check reads what the
 * repo stores, so it runs here, after the root lock and in the transaction
 * that writes: the lock is what makes a concurrent write of the same subject
 * wait and then see this one. Rows of records this batch rewrites or removes
 * do not count; the batch's own subjects were already compared among
 * themselves.
 */
async function assertNoSubjectConflicts(
  store: ActorTransactor,
  planned: PlannedWrite[],
  subjectCollections: ReadonlySet<string>,
): Promise<void> {
  const rewritten = new Set(planned.map((write) => write.uri))
  for (const write of planned) {
    if (write.kind === 'delete' || !subjectCollections.has(write.collection)) {
      continue
    }
    const conflicts = await store.record.getBacklinkConflicts(
      write.uri,
      write.record,
    )
    if (conflicts.some((conflict) => !rewritten.has(conflict.toString()))) {
      throw interactionAlreadyExists()
    }
  }
}

async function readStoredState(
  store: ActorTransactor,
  uri: string,
): Promise<StoredRecordState> {
  // true keeps a taken-down record visible: it still occupies its key.
  const existing = await store.record.getRecord(uri, null, true)
  // Read unconditionally: a refused delete of a missing record and of one in
  // another boundary then run the same statements.
  const boundaries = await store.record.getRecordBoundaries(uri)
  return {
    exists: existing !== null,
    takenDown: existing?.takedownRef != null,
    boundaries,
  }
}

function isHeldOnlyIn(stored: StoredRecordState, boundary: string): boolean {
  return (
    stored.exists &&
    stored.boundaries.length === 1 &&
    stored.boundaries[0] === boundary
  )
}

function isUpdatable(stored: StoredRecordState, boundary: string): boolean {
  return isHeldOnlyIn(stored, boundary) && !stored.takenDown
}

const planBatchWrite: WritePlanner = (write, stored, boundary) => {
  switch (write.kind) {
    case 'create':
      if (stored.exists) throw recordAlreadyExists()
      return 'create'
    case 'put':
      if (!stored.exists) return 'create'
      if (!isUpdatable(stored, boundary)) throw recordAlreadyExists()
      return 'update'
    case 'update':
      if (!isUpdatable(stored, boundary)) throw recordNotFound()
      return 'update'
    case 'delete':
      if (!isHeldOnlyIn(stored, boundary)) throw recordNotFound()
      return 'delete'
  }
}

const planSingleDelete: WritePlanner = (_write, stored, boundary) =>
  isHeldOnlyIn(stored, boundary) ? 'delete' : null

function recordAlreadyExists(): InvalidRequestError {
  return new InvalidRequestError('Record already exists', 'RecordAlreadyExists')
}

function interactionAlreadyExists(): InvalidRequestError {
  return new InvalidRequestError(
    'The member already has this interaction with the subject',
    'RecordAlreadyExists',
  )
}

function recordNotFound(): InvalidRequestError {
  return new InvalidRequestError('Record not found', 'RecordNotFound')
}

function toMstWriteOp(write: PlannedWrite): MstWriteOp {
  return {
    action: write.action,
    collection: write.collection,
    rkey: write.rkey,
    cid: write.kind === 'delete' ? null : parseCid(write.cid).toString(),
  }
}

async function applyPlannedWrite(
  store: ActorTransactor,
  write: PlannedWrite,
  boundary: string,
  rev: string,
): Promise<BatchWriteResult> {
  if (write.kind === 'delete') {
    await store.record.deleteRecord(write.uri)
    await store.blob.removeRecordBlobAssociations(write.uri)
    return {}
  }
  await store.record.indexRecordInBoundary(
    write.uri,
    write.cid,
    write.record,
    boundary,
    write.action === 'create' ? 'create' : 'update',
    rev,
  )
  // An update replaces the blob set so dropped blobs leave the index.
  if (write.action === 'update') {
    await store.blob.removeRecordBlobAssociations(write.uri)
  }
  for (const blobCid of StratosValidator.extractBlobs(write.record)) {
    await store.blob.associateBlobWithRecord(parseCid(blobCid), write.uri)
  }
  return {
    uri: write.uri,
    cid: parseCid(write.cid).toString(),
    ...(write.validationStatus && { validationStatus: write.validationStatus }),
  }
}

async function sequencePlannedWrite(
  store: ActorTransactor,
  write: PlannedWrite,
  boundary: string,
  commitCid: string,
  rev: string,
  trace: SequenceTrace,
): Promise<void> {
  if (write.kind === 'delete') {
    await sequenceChange(store, {
      action: 'delete',
      uri: write.uri,
      commitCid,
      rev,
      trace,
    })
    // The plain delete carries no boundary and reaches no subscriber, so the
    // scoped removal is what tells members of the record's boundary.
    if (write.storedBoundaries.length > 0) {
      await sequenceChange(store, {
        action: 'delete',
        uri: write.uri,
        boundary: {
          values: write.storedBoundaries.map((value) => ({ value })),
        },
        commitCid,
        rev,
        trace,
      })
    }
    return
  }
  await sequenceChange(store, {
    action: write.action === 'create' ? 'create' : 'update',
    uri: write.uri,
    cid: write.cid.toString(),
    record: write.record,
    boundary: opBoundary(boundary),
    commitCid,
    rev,
    trace,
  })
}
