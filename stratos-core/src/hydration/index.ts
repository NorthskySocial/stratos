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
  hasIntersection,
  filterAccessibleRecords,
  parseServiceEndpoint,
  isLocalService,
  createHydrationContext,
} from './domain.js'
