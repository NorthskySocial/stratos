import { randomInt } from 'node:crypto'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { AtUri as AtUriSyntax } from '@atproto/syntax'
import {
  assertBoundaryMatchesService,
  BoundaryServiceMismatchError,
  StratosValidationError,
  StratosValidator,
} from '@northskysocial/stratos-core'
import { MissingBlockError } from '@atcute/mst'
import type { AppContext } from '../../context.js'

// Cache the boundaries in case a post gets _really_ popular
const parentBoundaryCache = new Map<
  string,
  { boundaries: string[] | undefined; cachedAt: number }
>()
const PARENT_BOUNDARY_TTL_MS = 60_000

/**
 * Validates that the caller has permission to write domains in the given collection.
 * @param ctx - Application context
 * @param callerDid - DID of the caller
 * @param collection - Collection name
 * @param record - Record data
 * @throws InvalidRequestError if the caller is not authorized to write domains
 */
export async function assertCallerCanWriteDomains(
  ctx: AppContext,
  callerDid: string,
  collection: string,
  record: unknown,
): Promise<void> {
  if (!collection.startsWith('zone.stratos.')) {
    return
  }

  const requestedDomains = StratosValidator.extractBoundaryDomains(
    record as Record<string, unknown>,
  )
  if (requestedDomains.length === 0) {
    return
  }

  // Reject records whose boundaries target a different Stratos service
  for (const domain of requestedDomains) {
    try {
      assertBoundaryMatchesService(domain, ctx.serviceDid)
    } catch (err) {
      if (err instanceof BoundaryServiceMismatchError) {
        throw new InvalidRequestError(err.message, 'ServiceMismatch')
      }
      throw err
    }
  }

  const callerDomains = await ctx.boundaryResolver.getBoundaries(callerDid)
  const missingDomains = requestedDomains.filter(
    (domain) => !callerDomains.includes(domain),
  )

  if (missingDomains.length > 0) {
    const availableDomains =
      callerDomains.length > 0 ? callerDomains.join(', ') : '(none)'
    throw new InvalidRequestError(
      `You do not have access to boundary domain(s): ${missingDomains.join(', ')}. Your enrolled domains: ${availableDomains}`,
      'ForbiddenBoundary',
    )
  }
}

/**
 * Validates that the caller has permission to write records in the given collection.
 * @param ctx - Application context
 * @param callerDid - DID of the caller
 * @param collection - Collection name
 * @param record - Record data
 * @throws InvalidRequestError if the caller is not authorized to write records
 */
export async function validateWritableRecord(
  ctx: AppContext,
  callerDid: string,
  collection: string,
  record: unknown,
): Promise<void> {
  const rec = record as Record<string, unknown>

  // Resolve parent boundaries when the record is a reply
  const parentBoundaries = await resolveParentBoundaries(ctx, rec)

  const validator = new StratosValidator(ctx.cfg.stratos)
  try {
    validator.assertValid(rec, collection, parentBoundaries)
  } catch (err) {
    if (err instanceof StratosValidationError) {
      throw new InvalidRequestError(err.message, 'InvalidRecord')
    }
    throw err
  }

  await assertCallerCanWriteDomains(ctx, callerDid, collection, record)
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

  let parentUri: AtUriSyntax
  try {
    parentUri = new AtUriSyntax(reply.parent.uri)
  } catch {
    return undefined
  }

  const cacheKey = reply.parent.uri
  const cached = parentBoundaryCache.get(cacheKey)
  if (cached && Date.now() - cached.cachedAt < PARENT_BOUNDARY_TTL_MS) {
    return cached.boundaries
  }

  const boundaries = await ctx.actorStore.read(
    parentUri.hostname,
    async (store) => {
      const parentRecord = await store.record.getRecord(parentUri, null)
      if (!parentRecord) {
        return undefined
      }
      return StratosValidator.extractBoundaryDomains(parentRecord.value)
    },
  )

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
      'Concurrent modification detected, please retry',
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
