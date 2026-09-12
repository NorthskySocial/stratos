import type { BoundaryDetails, BoundarySettings } from './api/boundary-catalog'

export interface BoundaryDraft extends Omit<BoundarySettings, 'clientIds'> {
  name: string
  clientIdsText: string
}

export function newBoundaryDraft(): BoundaryDraft {
  return {
    name: '',
    displayName: '',
    description: '',
    listed: false,
    joinable: false,
    autoEnroll: false,
    appAccess: 'open',
    clientIdsText: '',
  }
}

export function editBoundaryDraft(boundary: BoundaryDetails): BoundaryDraft {
  return {
    name: boundary.roomId,
    displayName: boundary.displayName,
    description: boundary.description,
    listed: boundary.listed,
    joinable: boundary.joinable,
    autoEnroll: boundary.autoEnroll,
    appAccess: boundary.appAccess,
    clientIdsText: boundary.clientIds.join('\n'),
  }
}

export function boundarySettings(draft: BoundaryDraft): BoundarySettings {
  return {
    displayName: draft.displayName.trim(),
    description: draft.description,
    listed: draft.listed,
    joinable: draft.joinable,
    autoEnroll: draft.autoEnroll,
    appAccess: draft.appAccess,
    clientIds:
      draft.appAccess === 'allowList'
        ? draft.clientIdsText
            .split('\n')
            .map((id) => id.trim())
            .filter(Boolean)
        : [],
  }
}
