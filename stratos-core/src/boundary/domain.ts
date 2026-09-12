import { ensureValidRecordKey } from '@atproto/syntax'
import { ensureQualifiedBoundaries } from '../validation/boundary-qualification.js'
import { StratosError } from '../shared/errors.js'
import type { BoundarySettings } from './types.js'

export class BoundaryManagementError extends StratosError {
  constructor(message: string, code: string) {
    super(message, code)
  }
}

export function qualifyNewBoundary(serviceDid: string, name: string): string {
  try {
    ensureValidRecordKey(name)
  } catch {
    throw new BoundaryManagementError(
      'Use a valid boundary name',
      'InvalidRequest',
    )
  }
  const [boundary] = ensureQualifiedBoundaries(serviceDid, [name])
  if (name.length > 128)
    throw new BoundaryManagementError(
      'Use a bare boundary name of at most 128 characters',
      'InvalidRequest',
    )
  return boundary
}

export function validateBoundarySettings(settings: BoundarySettings): void {
  if (
    !settings.displayName.trim() ||
    settings.displayName.length > 120 ||
    settings.description.length > 2000
  )
    throw new BoundaryManagementError(
      'Provide a name up to 120 characters and a description up to 2000 characters',
      'InvalidRequest',
    )
  if (settings.appAccess !== 'open' && settings.appAccess !== 'allowList')
    throw new BoundaryManagementError(
      'Choose an application access policy',
      'InvalidRequest',
    )
  if (settings.appAccess === 'allowList' && settings.clientIds.length === 0)
    throw new BoundaryManagementError(
      'Add at least one allowed application',
      'InvalidRequest',
    )
  if (
    settings.clientIds.length > 100 ||
    settings.clientIds.some((id) => {
      try {
        const url = new URL(id)
        return (
          url.protocol !== 'https:' ||
          !!url.username ||
          !!url.password ||
          !!url.hash
        )
      } catch {
        return true
      }
    })
  )
    throw new BoundaryManagementError(
      'Application IDs must be HTTPS URLs without credentials or fragments',
      'InvalidRequest',
    )
}
