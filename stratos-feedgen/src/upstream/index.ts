export { UpstreamStratosClient } from './client.js'
export type {
  GetBlobResult,
  GetSpaceCredentialOptions,
  GetSpaceCredentialResult,
  HydrateRecordsResult,
  HydratedRecord,
  ResolveEnrollmentsResult,
  UpstreamStratosClientOptions,
} from './client.js'
export { StratosClientError } from './errors.js'
export {
  describeUpstreamError,
  MAX_LOGGED_ERROR_BODY_LENGTH,
} from './format-error.js'
export { SERVICE_JWT_LIFETIME_SECONDS, mintServiceJwt } from './jwt.js'
export type { MintServiceJwtOptions } from './jwt.js'
