import { randomInt } from 'node:crypto'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { AtUri as AtUriSyntax } from '@atproto/syntax'
import {
  assertBoundaryMatchesService,
  BoundaryServiceMismatchError,
  buildRecordRules,
  findRecordRule,
  isEligibleSubject,
  isValidSkey,
  parseRecordUri,
  parseQualifiedBoundary,
  qualifyBoundary,
  type RecordRule,
  type RecordRuleInput,
  type StratosConfig,
  StratosValidationError,
  StratosValidator,
  SUBJECT_ERROR_MESSAGE,
} from '@northskysocial/stratos-core'
import { MissingBlockError } from '@atcute/mst'
import type { AppContext } from '../../context.js'
import {
  HOSTED_SPACE_TYPE,
  SPACE_TYPE_REGISTRY,
} from '../../shared/space-type-registry.js'
import { isWellFormedStrongRef } from './lexicon-validation.js'
import { resolveReferencedRecord } from './references.js'

// Cache the boundaries in case a post gets _really_ popular.
// Exported for tests: they clear the cache and check its insertion order.
export const parentBoundaryCache = new Map<
  string,
  { boundaries: string[] | undefined; cachedAt: number }
>()
const PARENT_BOUNDARY_TTL_MS = 60_000
export const PARENT_BOUNDARY_CACHE_MAX = 1000

const POST_COLLECTION = 'zone.stratos.feed.post'

const recordRulesByConfig = new WeakMap<
  StratosConfig,
  ReadonlyMap<string, RecordRule>
>()

/** The record rules of one service configuration, built the first time they are asked for. */
export function recordRulesFor(
  config: StratosConfig,
): ReadonlyMap<string, RecordRule> {
  let rules = recordRulesByConfig.get(config)
  if (!rules) {
    rules = buildRecordRules(config)
    recordRulesByConfig.set(config, rules)
  }
  return rules
}

export function assertCollectionInHostedSpaceType(collection: string): void {
  if (!SPACE_TYPE_REGISTRY.allowsCollection(HOSTED_SPACE_TYPE, collection)) {
    throw new InvalidRequestError(
      `Collection ${collection} is not allowed in space type ${HOSTED_SPACE_TYPE}`,
      'InvalidCollection',
    )
  }
}

/**
 * Reads the one boundary a record claims.
 * @throws InvalidRequestError if the record does not claim exactly one boundary
 */
export function extractRecordBoundary(record: unknown): string {
  const requestedDomains = StratosValidator.extractBoundaryDomains(
    record as Record<string, unknown>,
  )

  // One record, one space: exactly one domain is required. Zero domains and
  // more than one domain are both write errors (no legacy data to migrate).
  if (requestedDomains.length !== 1) {
    throw new InvalidRequestError(
      `Records must target exactly one domain, received ${requestedDomains.length}`,
      'InvalidDomainCount',
    )
  }
  return requestedDomains[0]
}

/**
 * Authorizes the caller to write to a boundary and returns it.
 * @throws InvalidRequestError if the boundary is malformed, targets another service, or is not held by the caller
 */
export async function authorizeBoundary(
  ctx: AppContext,
  callerDid: string,
  boundary: string,
): Promise<string> {
  // The bare domain name is the space skey; validate it as such.
  const bareName = parseQualifiedBoundary(boundary)?.name ?? boundary
  if (!isValidSkey(bareName)) {
    throw new InvalidRequestError(
      `Domain "${boundary}" is not a valid domain skey`,
      'InvalidDomain',
    )
  }

  // Reject boundaries that target a different Stratos service
  try {
    assertBoundaryMatchesService(boundary, ctx.serviceDid)
  } catch (err) {
    if (err instanceof BoundaryServiceMismatchError) {
      throw new InvalidRequestError(err.message, 'ServiceMismatch')
    }
    throw err
  }

  // a hand-built context without a write cache falls back to the live resolver
  const callerDomains = await (
    ctx.writeBoundaryResolver ?? ctx.boundaryResolver
  ).getBoundaries(callerDid)

  if (!callerDomains.includes(boundary)) {
    const availableDomains =
      callerDomains.length > 0 ? callerDomains.join(', ') : '(none)'
    throw new InvalidRequestError(
      `You do not have access to boundary domain(s): ${boundary}. Your enrolled domains: ${availableDomains}`,
      'ForbiddenBoundary',
    )
  }

  return boundary
}

/**
 * Authorizes the caller to write the record's single boundary and returns it.
 * @throws InvalidRequestError if the boundary is not exactly one, is malformed, targets another service, or is not held by the caller
 */
export async function authorizeRecordBoundary(
  ctx: AppContext,
  callerDid: string,
  collection: string,
  record: unknown,
): Promise<string> {
  return authorizeBoundary(ctx, callerDid, extractRecordBoundary(record))
}

/**
 * Refuses a boundary whose catalog entry is not active. The write cache can
 * list a boundary for up to its TTL after the catalog deactivated it, so
 * membership alone does not say the boundary still accepts writes. It reads the
 * store, which every process shares, rather than the in-memory allowed domains.
 * @throws InvalidRequestError `BoundaryNotFound` when the boundary is absent, not active, or there is no catalog store to read
 */
export async function assertBoundaryInCatalog(
  ctx: AppContext,
  boundary: string,
): Promise<void> {
  // Without a catalog store the boundary cannot be shown to be active, so the
  // write is refused rather than allowed unchecked.
  const definition = await ctx.boundaryStore?.get(boundary)
  if (definition?.status !== 'active') {
    throw new InvalidRequestError(
      `Boundary ${boundary} is not in the active catalog`,
      'BoundaryNotFound',
    )
  }
}

/**
 * Validates a legacy write against the lexicon and Stratos record rules, judging
 * the boundary the body claims. It runs on every legacy write; `validate: false`
 * cannot skip it. Its `allowedDomains` check is what rejects a boundary the
 * catalog has just deactivated, while the write cache still lists it for the
 * member.
 */
export async function validateLegacyRecordContent(
  ctx: AppContext,
  collection: string,
  record: unknown,
): Promise<void> {
  const rec = record as Record<string, unknown>
  const parentBoundaries = await resolveParentBoundaries(ctx, rec)

  assertRulesHold(() =>
    new StratosValidator(ctx.cfg.stratos).assertValid(
      rec,
      collection,
      parentBoundaries,
    ),
  )
}

/**
 * Validates a write into one named boundary. The rules judge that boundary and
 * never the record's own claim.
 */
export async function validateRecordInBoundary(
  ctx: AppContext,
  collection: string,
  record: unknown,
  boundary: string,
): Promise<void> {
  const rec = record as Record<string, unknown>
  assertReferenceUrisAreStrings(collection, rec)
  const subjectRule = findRecordRule(
    recordRulesFor(ctx.cfg.stratos),
    collection,
  )?.subject
  // A record that points at a subject has no use for a reply parent, and the
  // parent's actor store may not exist: a stray reply field must not decide
  // its outcome.
  const parentBoundaries = subjectRule
    ? undefined
    : await judgeParentBoundaries(ctx, rec, boundary)
  const subject = subjectRule
    ? await judgeSubject(ctx, subjectRule, rec, boundary)
    : undefined

  assertRulesHold(() =>
    new StratosValidator(ctx.cfg.stratos).assertValidWithInput(
      rec,
      collection,
      {
        boundaryClaim: { values: [{ value: boundary }] },
        parentBoundaries,
        subject,
      },
    ),
  )
}

/**
 * Refuses a subject that is not a well-formed reference with the subject
 * error. It runs in every validate mode and before the lexicon check, which
 * would otherwise answer a misshapen subject in its own words.
 * @throws InvalidRequestError `InvalidRecord` with the subject error
 */
export function assertSubjectWellFormed(record: Record<string, unknown>): void {
  if (isWellFormedStrongRef(record.subject)) return
  throw new InvalidRequestError(SUBJECT_ERROR_MESSAGE, 'InvalidRecord')
}

/**
 * Looks up the subject of a record whose rule names one and decides whether
 * the record may point at it.
 */
async function judgeSubject(
  ctx: AppContext,
  subjectRule: NonNullable<RecordRule['subject']>,
  record: Record<string, unknown>,
  boundary: string,
): Promise<NonNullable<RecordRuleInput['subject']>> {
  const claimedCid = asObject(record.subject)?.cid
  const facts = await resolveReferencedRecord(ctx, record.subject)
  return {
    eligible: isEligibleSubject(facts, {
      boundary,
      serviceDid: ctx.serviceDid,
      spaceType: HOSTED_SPACE_TYPE,
      collections: subjectRule.collections,
      cid: typeof claimedCid === 'string' ? claimedCid : undefined,
    }),
  }
}

/**
 * The boundaries a reply inherits from its parent on a boundary write. A
 * space-form parent names its boundary in a URI that anyone can write, so it
 * counts only as a post by an active pds-custody member of this boundary in the
 * hosted space type. Any other space-form parent holds no boundary, and the
 * reply rules refuse the reply as they refuse a parent in another boundary.
 */
async function judgeParentBoundaries(
  ctx: AppContext,
  record: Record<string, unknown>,
  boundary: string,
): Promise<string[] | undefined> {
  const parentBoundaries = await resolveParentBoundaries(ctx, record)
  const parent = asObject(asObject(record.reply)?.parent)
  if (typeof parent?.uri !== 'string' || !parseRecordUri(parent.uri).ok) {
    return parentBoundaries
  }
  const facts = await resolveReferencedRecord(ctx, parent)
  const eligible = isEligibleSubject(facts, {
    boundary,
    serviceDid: ctx.serviceDid,
    spaceType: HOSTED_SPACE_TYPE,
    collections: [POST_COLLECTION],
    cid: typeof parent.cid === 'string' ? parent.cid : undefined,
  })
  return eligible ? parentBoundaries : []
}

/**
 * Refuses a record whose reply or embedded record references carry a uri that
 * is not a string. The rules and the parent lookup call string methods on these
 * uris and run even when lexicon validation is skipped, so they cannot rely on
 * the lexicon's shapes.
 * @throws InvalidRequestError `InvalidRecord` naming the collection, never the value
 */
function assertReferenceUrisAreStrings(
  collection: string,
  record: Record<string, unknown>,
): void {
  const reply = asObject(record.reply)
  const uris = [asObject(reply?.parent)?.uri, asObject(reply?.root)?.uri]
  if (collection === POST_COLLECTION) {
    for (
      let embed = asObject(record.embed);
      embed;
      embed = asObject(embed.media)
    ) {
      uris.push(asObject(embed.record)?.uri)
    }
  }
  if (uris.some((uri) => uri !== undefined && typeof uri !== 'string')) {
    throw new InvalidRequestError(
      `Invalid ${collection} record: a reference uri must be a string`,
      'InvalidRecord',
    )
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function assertRulesHold(validate: () => void): void {
  try {
    validate()
  } catch (err) {
    if (err instanceof StratosValidationError) {
      throw new InvalidRequestError(err.message, 'InvalidRecord')
    }
    throw err
  }
}

/**
 * Validates that the record has valid parent boundaries.
 * @param ctx - Application context
 * @param record - Record data
 * @returns Array of parent boundaries or undefined if no parent boundaries are found
 */
export async function resolveParentBoundaries(
  ctx: AppContext,
  record: Record<string, unknown>,
): Promise<string[] | undefined> {
  const reply = record.reply as { parent?: { uri?: string } } | undefined
  if (!reply?.parent?.uri) {
    return undefined
  }

  const spaceRecord = parseRecordUri(reply.parent.uri)
  if (spaceRecord.ok) {
    return [qualifyBoundary(spaceRecord.value.spaceDid, spaceRecord.value.skey)]
  }

  let parentUri: AtUriSyntax
  try {
    parentUri = new AtUriSyntax(reply.parent.uri)
  } catch {
    return undefined
  }

  const cacheKey = reply.parent.uri
  const cached = parentBoundaryCache.get(cacheKey)
  if (cached) {
    if (Date.now() - cached.cachedAt < PARENT_BOUNDARY_TTL_MS) {
      return cached.boundaries
    }
    parentBoundaryCache.delete(cacheKey)
  }

  const boundaries = await ctx.actorStore.read(
    parentUri.hostname,
    async (store) => {
      const parent =
        await store.record.getVisibleRecordWithBoundaries(parentUri)
      return parent?.boundaries
    },
  )

  if (parentBoundaryCache.size >= PARENT_BOUNDARY_CACHE_MAX) {
    const oldestKey = parentBoundaryCache.keys().next().value
    if (oldestKey !== undefined) {
      parentBoundaryCache.delete(oldestKey)
    }
  }
  parentBoundaryCache.set(cacheKey, { boundaries, cachedAt: Date.now() })
  return boundaries
}

/**
 * Asserts that the root CID has not changed.
 * @param currentRootCid - Current root CID
 * @param expectedRootCid - Expected root CID
 * @throws InvalidRequestError if the root CID has changed
 */
export function assertRootUnchanged(
  currentRootCid: string | null,
  expectedRootCid: string | null,
): void {
  if (currentRootCid !== expectedRootCid) {
    throw new InvalidRequestError(
      `Concurrent modification detected (expected ${expectedRootCid}, found ${currentRootCid}), please retry`,
      'ConcurrentModification',
    )
  }
}

export const MAX_CONCURRENCY_RETRIES = 4
export const BASE_RETRY_DELAY_MS = 25

/**
 * Checks if the given error is a retriable write error.
 * @param err - Error object
 * @returns True if the error is retriable, false otherwise
 */
export function isRetriableWriteError(err: unknown): boolean {
  if (
    (err instanceof InvalidRequestError &&
      (err as { customErrorName?: string }).customErrorName ===
        'ConcurrentModification') ||
    err instanceof MissingBlockError
  ) {
    return true
  }
  // pg lock_timeout exceeded (SQLSTATE 55P03 — lock_not_available)
  const code = (err as { code?: string })?.code
  return code === '55P03'
}

/**
 * Executes the given function with concurrency retry logic.
 * @param fn - Function to execute
 * @param logger - Logger instance (optional)
 * @returns Result of the function and number of retries
 * @throws Error if the maximum number of retries is exceeded
 */
export async function withConcurrencyRetry<T>(
  fn: (attempt: number) => Promise<T>,
  logger?: AppContext['logger'],
): Promise<{ result: T; retries: number }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await fn(attempt)
      return { result, retries: attempt }
    } catch (err) {
      if (!isRetriableWriteError(err) || attempt >= MAX_CONCURRENCY_RETRIES) {
        throw err
      }
      const jitter = randomInt(BASE_RETRY_DELAY_MS)
      const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt) + jitter
      logger?.info(
        { attempt: attempt + 1, delayMs: Math.round(delay) },
        'retrying after concurrent modification',
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}
