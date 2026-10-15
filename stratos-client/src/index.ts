export {
  createServiceAssertion,
  verifyServiceAssertion,
  type ServiceAssertionContext,
  type CreateServiceAssertionOptions,
  type ServiceAssertionKeyResolver,
  type VerifiedServiceAssertion,
} from './service-assertion.js'

export {
  createRequestProof,
  verifyRequestProof,
  requestProofReplayEntry,
  type RequestProofContext,
  type CreateRequestProofOptions,
  type RequestProofClaims,
  type VerifiedRequestProof,
  type RequestProofReplayStore,
  type RequestProofReplayEntry,
} from './request-proof.js'

export {
  appendServiceKeyHistory,
  verifyServiceKeyHistory,
  findHistoricalSigningKey,
  keyHistoryTimestamp,
  MAX_KEY_HISTORY_ENTRIES,
  type ServiceKeyHistory,
  type ServiceKeyHistoryEntry,
  type HistorySigner,
} from './key-history.js'

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
  resolveRepositoryTarget,
  findEnrollmentByService,
  serviceDIDToRkey,
  type ServiceFetchHandlerOptions,
  type RepositoryTarget,
  type TrustedRepositoryHosts,
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
  type VerifyAttestationOptions,
} from './attestation.js'
export {
  STRATOS_SCOPES,
  buildCollectionScope,
  buildRpcScope,
  buildStratosScopes,
} from './scopes.js'
