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

// The reference PDS allows each writing repo this many notices an hour.
const NOTICES_PER_ISSUER_PER_HOUR = 1500
const HOUR_MS = 60 * 60 * 1000

// No pinned package ships this lexicon, so the route is plain express, and
// the global parser skips `/xrpc/` paths.
const noticeJsonParser = express.json({ limit: '100kb' })

/**
 * Serve `com.atproto.space.notifyRepoUpdate`. The notice is checked and
 * acknowledged; nothing is stored or forwarded, because the feed generator
 * polls a member's PDS on its own schedule.
 */
export function registerRepoUpdateNoticeHandler(
  ctx: AppContext,
  limiter = new WriteRateLimiter({
    maxWrites: NOTICES_PER_ISSUER_PER_HOUR,
    windowMs: HOUR_MS,
  }),
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
        limiter.assertWriteAllowed(iss)
        const notice = await acceptRepoUpdateNotice(ctx, iss, req.body)
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
    answerUnparseableBody,
  )
}

async function acceptRepoUpdateNotice(
  ctx: AppContext,
  iss: string,
  body: unknown,
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

  const boundary = await resolveHostedBoundary(ctx, notice.space)

  if (isRepoRevTooFarAhead(notice.repoRev, Date.now())) {
    throw new InvalidRequestError('Repo revision is in the future', 'FutureRev')
  }

  await assertSpaceWriter(ctx, notice.repo, boundary)
  return notice
}

async function resolveHostedBoundary(
  ctx: AppContext,
  space: string,
): Promise<string> {
  const boundary = spaceUriToBoundary(space, ctx.serviceDid)
  // A hosted space is spelled exactly as its boundary maps back, which also
  // refuses a space of another type with the same key.
  const hostedSpelling = boundary.ok
    ? boundaryToSpaceUri(boundary.value, HOSTED_SPACE_TYPE)
    : undefined
  if (!boundary.ok || !hostedSpelling?.ok || hostedSpelling.value !== space) {
    throw new InvalidRequestError('Space not found', 'SpaceNotFound')
  }
  const definition = await ctx.boundaryStore?.get(boundary.value)
  if (definition?.status !== 'active') {
    throw new InvalidRequestError('Space not found', 'SpaceNotFound')
  }
  return boundary.value
}

// A stratos-custody member's repo lives here, not on a PDS, so only a
// pds-custody member's host has anything to notify about.
async function assertSpaceWriter(
  ctx: AppContext,
  repo: string,
  boundary: string,
): Promise<void> {
  const enrollment = await ctx.enrollmentStore.getEnrollment(repo)
  const isPdsMember =
    enrollment?.active === true && enrollment.custody === 'pds'
  const boundaries = isPdsMember
    ? await ctx.enrollmentStore.getBoundaries(repo)
    : []
  if (!boundaries.includes(boundary)) {
    throw new ForbiddenError('Repo is not authorized to write to the space')
  }
}

function answerXrpcError(res: Response, err: XRPCError): void {
  if (err instanceof RateLimitError) {
    res.set('Retry-After', String(err.retryAfter))
  }
  res.status(err.statusCode).json(err.payload)
}

function answerUnparseableBody(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const isParseFailure =
    typeof err === 'object' &&
    err !== null &&
    (err as { type?: unknown }).type === 'entity.parse.failed'
  if (!isParseFailure) {
    next(err)
    return
  }
  res.status(400).json({
    error: 'InvalidRequest',
    message: 'Request body is not valid JSON',
  })
}
