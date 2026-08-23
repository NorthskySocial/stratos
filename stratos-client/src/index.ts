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

export {
  ENROLLMENT_COLLECTION,
  discoverEnrollment,
  discoverEnrollments,
  getEnrollmentByServiceDid,
  parseEnrollmentRecord,
} from './discovery.js'
export {
  createServiceFetchHandler,
  resolveServiceUrl,
  findEnrollmentByService,
  serviceDIDToRkey,
  type ServiceFetchHandlerOptions,
} from './routing.js'
export {
  verifyCidIntegrity,
  verifyRecordCid,
  resolveServiceSigningKey,
  resolveUserSigningKey,
  fetchAndVerifyRecord,
  verifyStratosRecord,
} from './verification.js'
export {
  verifyEnrollmentAttestation,
  type AttestationResult,
} from './attestation.js'
export {
  STRATOS_SCOPES,
  buildCollectionScope,
  buildRpcScope,
  buildStratosScopes,
} from './scopes.js'
