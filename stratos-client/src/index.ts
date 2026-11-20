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
  boundaryToSpaceUri,
  parseSpaceRecordUri,
  parseSpaceUri,
  type BoundarySpaceUriResult,
  type SpaceRecordUriParts,
  type SpaceUriParseResult,
  type SpaceUriParts,
} from './space-uri.js'
export {
  STRATOS_SCOPES,
  buildCollectionScope,
  buildRpcScope,
  buildStratosScopes,
} from './scopes.js'
export {
  applyBoundaryWrites,
  BoundaryWriteError,
  createBoundaryRecord,
  deleteBoundaryRecord,
  putBoundaryRecord,
  ScopeUpgradeRequiredError,
  type ApplyBoundaryWritesInput,
  type ApplyBoundaryWritesOutput,
  type BoundaryWriteAction,
  type BoundaryWriteClient,
  type BoundaryWriteOperation,
  type BoundaryWriteRefusal,
  type BoundaryWriteResult,
  type CreateBoundaryRecordInput,
  type DeleteBoundaryRecordInput,
  type PutBoundaryRecordInput,
  type RecordWriteOutput,
  type UnresolvedReason,
} from './writes.js'
