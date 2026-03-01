export type {
  FetchHandler,
  FetchHandlerObject,
  FetchAndVerifyOptions,
  ResolveSigningKeyOptions,
  ServiceAttestation,
  StratosEnrollment,
  StratosScopes,
  VerificationLevel,
  VerifiedRecord,
} from './types.js'

export { discoverEnrollment } from './discovery.js'
export { createServiceFetchHandler, resolveServiceUrl } from './routing.js'
export {
  verifyCidIntegrity,
  resolveServiceSigningKey,
  fetchAndVerifyRecord,
} from './verification.js'
export {
  STRATOS_SCOPES,
  buildCollectionScope,
  buildStratosScopes,
} from './scopes.js'
