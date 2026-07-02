// Types
export type {
  HydrationContext,
  HydrationRequest,
  HydratedRecord,
  HydrationResult,
  BatchHydrationResult,
  HydratableRecord,
  AccessCheckInput,
} from './types.js'

// Ports
export type {
  HydrationService,
  RecordResolver,
  BoundaryResolver,
} from './port.js'

// Domain functions
export {
  canAccessRecord,
  isDomainlessRecord,
  hasIntersection,
  filterAccessibleRecords,
  parseServiceEndpoint,
  isLocalService,
  createHydrationContext,
  hydrateRecordBlobs,
} from './domain.js'
