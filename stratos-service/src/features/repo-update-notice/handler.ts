import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express'
import {
  ForbiddenError,
  InvalidRequestError,
  XRPCError,
} from '@atproto/xrpc-server'
import {
  boundaryToSpaceUri,
  isRepoRevTooFarAhead,
  parseRepoUpdateNotice,
  spaceUriToBoundary,
  type RepoUpdateNotice,
} from '@northskysocial/stratos-core'
import type { AppContext } from '../../context-types.js'
import { createRepoHostNoticeVerifier } from '../../infra/auth/verifiers.js'
import { RateLimitError, WriteRateLimiter } from '../../shared/rate-limiter.js'
import { HOSTED_SPACE_TYPE } from '../../shared/space-type-registry.js'

/** The upstream notice a member's PDS sends after a write to a space repo. */
export const NOTIFY_REPO_UPDATE_METHOD = 'com.atproto.space.notifyRepoUpdate'

// The reference PDS allows each writing repo this many notices an hour and a
// day.
const NOTICES_PER_ISSUER_PER_HOUR = 1500
const NOTICES_PER_ISSUER_PER_DAY = 10_000
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

// No pinned package ships this lexicon, so the route is plain express, and
// the global parser skips `/xrpc/` paths.
const noticeJsonParser = express.json({ limit: '100kb' })

/** The hourly and daily allowances of one writing repo, in that order. */
export function createNoticeRateLimiters(): WriteRateLimiter[] {
  return [
    new WriteRateLimiter({
      maxWrites: NOTICES_PER_ISSUER_PER_HOUR,
      windowMs: HOUR_MS,
    }),
    new WriteRateLimiter({
      maxWrites: NOTICES_PER_ISSUER_PER_DAY,
      windowMs: DAY_MS,
    }),
  ]
}

/**
 * Serve `com.atproto.space.notifyRepoUpdate`. The notice is checked and
 * acknowledged; nothing is stored or forwarded, because the feed generator
 * polls a member's PDS on its own schedule.
 *
 * The limiters are charged only for a writer of the notified space, so they
 * hold an entry for a member, never for any issuer that can sign a token.
 */
export function registerRepoUpdateNoticeHandler(
  ctx: AppContext,
  limiters: readonly WriteRateLimiter[] = createNoticeRateLimiters(),
): void {
  const verifyNoticeAuth = createRepoHostNoticeVerifier({
    serviceDid: ctx.serviceDid,
    idResolver: ctx.idResolver,
    lxm: NOTIFY_REPO_UPDATE_METHOD,
  })

  ctx.app.post(
    `/xrpc/${NOTIFY_REPO_UPDATE_METHOD}`,
    noticeJsonParser,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { iss } = await verifyNoticeAuth(req)
        const notice = await acceptRepoUpdateNotice(
          ctx,
          iss,
          req.body,
          limiters,
        )
        ctx.logger?.debug(
          { space: notice.space, repo: notice.repo, repoRev: notice.repoRev },
          'repo update notice accepted',
        )
        res.status(200).end()
      } catch (err) {
        if (err instanceof XRPCError) {
          answerXrpcError(res, err)
          return
        }
        next(err)
      }
    },
    answerRefusedBody,
  )
}

// Everything after the writer check answers only a writer of the space: a
// boundary that is absent, inactive or not the issuer's gets one answer, so
// an outsider learns nothing from the catalog or the revision.
async function acceptRepoUpdateNotice(
  ctx: AppContext,
  iss: string,
  body: unknown,
  limiters: readonly WriteRateLimiter[],
): Promise<RepoUpdateNotice> {
  const parsed = parseRepoUpdateNotice(body)
  if (!parsed.ok) {
    throw new InvalidRequestError(parsed.message, 'InvalidRequest')
  }
  const notice = parsed.value

  // iss signed the token, so a host cannot notify for an account whose key it
  // does not hold.
  if (iss !== notice.repo) {
    throw new ForbiddenError('Notification iss does not match the repo')
  }

  const boundary = hostedBoundaryOf(ctx, notice.space)
  await assertSpaceWriter(ctx, notice.repo, boundary)
  for (const limiter of limiters) {
    limiter.assertWriteAllowed(iss)
  }
  const definition = await ctx.boundaryStore?.get(boundary)
  if (definition?.status !== 'active') {
    throw notAWriter()
  }

  if (isRepoRevTooFarAhead(notice.repoRev, Date.now())) {
    throw new InvalidRequestError('Repo revision is in the future', 'FutureRev')
  }
  return notice
}

// Read from the URI alone, so it tells a caller nothing the URI did not.
function hostedBoundaryOf(ctx: AppContext, space: string): string {
  const boundary = spaceUriToBoundary(space, ctx.serviceDid)
  // A hosted space is spelled exactly as its boundary maps back, which also
  // refuses a space of another type with the same key.
  const hostedSpelling = boundary.ok
    ? boundaryToSpaceUri(boundary.value, HOSTED_SPACE_TYPE)
    : undefined
  if (!boundary.ok || !hostedSpelling?.ok || hostedSpelling.value !== space) {
    throw new InvalidRequestError('Space not found', 'SpaceNotFound')
  }
  return boundary.value
}

// A stratos-custody member's repo lives here, not on a PDS, so only a
// pds-custody member's host has anything to notify about. A service only
// reads, even one whose earlier enrollment kept pds custody.
async function assertSpaceWriter(
  ctx: AppContext,
  repo: string,
  boundary: string,
): Promise<void> {
  const enrollment = await ctx.enrollmentStore.getEnrollment(repo)
  const isPdsMember =
    enrollment?.active === true &&
    enrollment.custody === 'pds' &&
    enrollment.isService !== true
  const boundaries = isPdsMember
    ? await ctx.enrollmentStore.getBoundaries(repo)
    : []
  if (!boundaries.includes(boundary)) {
    throw notAWriter()
  }
}

function notAWriter(): ForbiddenError {
  return new ForbiddenError('Repo is not authorized to write to the space')
}

function answerXrpcError(res: Response, err: XRPCError): void {
  if (err instanceof RateLimitError) {
    res.set('Retry-After', String(err.retryAfter))
  }
  res.status(err.statusCode).json(err.payload)
}

// The body parser's refusals of what the client sent. Anything else it
// raises is the service's own failure and goes to the service error handler.
const BODY_REFUSALS: Readonly<
  Record<string, { status: number; error: string; message: string }>
> = {
  'entity.parse.failed': {
    status: 400,
    error: 'InvalidRequest',
    message: 'Request body is not valid JSON',
  },
  'entity.too.large': {
    status: 413,
    error: 'PayloadTooLarge',
    message: 'Request body is too large',
  },
  'charset.unsupported': {
    status: 415,
    error: 'UnsupportedMediaType',
    message: 'Request body charset is not supported',
  },
  'encoding.unsupported': {
    status: 415,
    error: 'UnsupportedMediaType',
    message: 'Request body content encoding is not supported',
  },
}

function answerRefusedBody(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const type =
    typeof err === 'object' && err !== null
      ? (err as { type?: unknown }).type
      : undefined
  const refusal =
    typeof type === 'string' && Object.hasOwn(BODY_REFUSALS, type)
      ? BODY_REFUSALS[type]
      : undefined
  if (!refusal) {
    next(err)
    return
  }
  res
    .status(refusal.status)
    .json({ error: refusal.error, message: refusal.message })
}
