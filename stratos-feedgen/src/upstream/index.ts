export { UpstreamStratosClient } from './client.js'
export type {
  GetBlobResult,
  GetSpaceCredentialOptions,
  GetSpaceCredentialResult,
  HydrateRecordsResult,
  HydratedRecord,
  ListSpaceReposOptions,
  ListSpaceReposResult,
  ResolveEnrollmentsResult,
  SpaceCredentialProof,
  SpaceRepoEntry,
  UpstreamStratosClientOptions,
} from './client.js'
export { StratosClientError, StratosInvalidResponseError } from './errors.js'
export { describeUpstreamError } from './format-error.js'
export { SERVICE_JWT_LIFETIME_SECONDS, mintServiceJwt } from './jwt.js'
export type { MintServiceJwtOptions } from './jwt.js'
