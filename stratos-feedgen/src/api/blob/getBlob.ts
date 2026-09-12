import {
  InvalidRequestError,
  NotEnoughResourcesError,
  type Server as XrpcServer,
} from '@atproto/xrpc-server'
import type { FeedRequestVerifier } from '../../auth/index.js'
import { canServePostBlobs } from '../../blob/custody.js'
import type { BlobService } from '../../blob/service.js'
import type { FeedgenStore } from '../../db/index.js'
import type { EnrollmentManager } from '../../enrollment/index.js'
import type { FeedReadiness } from '../../readiness.js'
import type { SpaceMutationFence } from '../../mutation-fence.js'
import { NSID } from '../../lexicon/index.js'
import { toXrpcAuthVerifier } from '../util.js'

export interface GetBlobDeps {
  store: Pick<FeedgenStore, 'getPost' | 'listSpaceMembers'>
  enrollmentManager: Pick<EnrollmentManager, 'getBoundaries'>
  verifier: FeedRequestVerifier
  mutationFence?: Pick<
    SpaceMutationFence,
    'captureRevocationEpoch' | 'hasPendingDidMutation'
  >
  configuredBoundaries?: ReadonlySet<string>
  readiness?: FeedReadiness
  blobs: Pick<BlobService, 'get'>
}

export function registerGetBlobHandler(
  server: XrpcServer,
  deps: GetBlobDeps,
): void {
  server.method(NSID.getBlob, {
    auth: toXrpcAuthVerifier(deps.verifier, NSID.getBlob),
    handler: async ({ params, auth, res }) => {
      const epoch = deps.mutationFence?.captureRevocationEpoch()
      const uri = params['uri'] as string
      const cid = params['cid'] as string
      const viewer = auth.credentials.viewerDid
      const { post } = await authorize(deps, viewer, uri, cid)
      const bytes = await deps.blobs.get(post.did, cid)
      const current = await authorize(deps, viewer, uri, cid)
      if (current.post.did !== post.did) throw unavailableBlob()
      if (
        epoch !== deps.mutationFence?.captureRevocationEpoch() ||
        deps.mutationFence?.hasPendingDidMutation(viewer) ||
        deps.mutationFence?.hasPendingDidMutation(post.did)
      )
        throw new NotEnoughResourcesError(
          'Blob authorization changed during download',
          'FeedNotReady',
        )
      res.setHeader('cache-control', 'private, no-store')
      res.setHeader('vary', 'Authorization')
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('content-security-policy', "default-src 'none'; sandbox")
      res.setHeader('content-disposition', 'attachment')
      return {
        encoding: safeMimeType(current.blob.mimeType),
        body: bytes,
      }
    },
  })
}

async function authorize(
  deps: GetBlobDeps,
  viewer: string,
  uri: string,
  cid: string,
) {
  assertReady(deps.readiness)
  const boundaries = await deps.enrollmentManager.getBoundaries(viewer)
  const post = await deps.store.getPost(uri)
  assertReady(deps.readiness)
  const blob = post?.blobRefs.find((ref) => ref.cid === cid)
  if (
    !post ||
    !blob ||
    !post.boundaries.some(
      (boundary) =>
        boundaries.includes(boundary) &&
        (deps.configuredBoundaries === undefined ||
          deps.configuredBoundaries.has(boundary)),
    )
  ) {
    throw unavailableBlob()
  }
  if (!(await canServePostBlobs(deps.store, post))) throw unavailableBlob()
  assertReady(deps.readiness)
  return { post, blob }
}

function assertReady(readiness?: FeedReadiness): void {
  if (readiness !== undefined && !readiness.isReady()) {
    throw new NotEnoughResourcesError(
      'Feed is unavailable while authorization state is reconciling',
      'FeedNotReady',
    )
  }
}

const MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
])

function safeMimeType(mimeType: string | undefined): string {
  return mimeType && MEDIA_TYPES.has(mimeType)
    ? mimeType
    : 'application/octet-stream'
}

function unavailableBlob(): InvalidRequestError {
  return new InvalidRequestError('Blob is unavailable', 'BlobNotFound')
}
