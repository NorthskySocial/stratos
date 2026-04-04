import {
  type BoundaryResolver,
  type EnrollmentStoreReader,
} from '@northskysocial/stratos-core'
import { EnrollmentBoundaryResolver } from '../enrollment/adapter.js'
import { type HydrationContext } from '../../context-types.js'

/**
 * Initialize hydration context
 * @param enrollmentStore - Enrollment store reader
 * @returns Hydration context
 */
export function initHydration(
  enrollmentStore: EnrollmentStoreReader,
): HydrationContext {
  const boundaryResolver: BoundaryResolver = new EnrollmentBoundaryResolver(
    enrollmentStore,
  )
  return { boundaryResolver }
}
