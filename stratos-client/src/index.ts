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

export { getEnrollmentByServiceDid } from './discovery.js'
export {
  createServiceFetchHandler,
  resolveServiceUrl,
  findEnrollmentByService,
  serviceDIDToRkey,
} from './routing.js'
export {
  verifyCidIntegrity,
  resolveServiceSigningKey,
  resolveUserSigningKey,
  fetchAndVerifyRecord,
} from './verification.js'
export {
  STRATOS_SCOPES,
  buildCollectionScope,
  buildStratosScopes,
} from './scopes.js'
