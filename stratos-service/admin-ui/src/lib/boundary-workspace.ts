export const BOUNDARY_TABS = ['overview', 'members', 'settings'] as const

export type BoundaryTab = (typeof BOUNDARY_TABS)[number]

export interface BoundarySelection {
  boundary: string | null
  tab: BoundaryTab
  valid: boolean
}

export function parseBoundarySelection(querystring: string): BoundarySelection {
  const rawQuery = querystring.startsWith('?')
    ? querystring.slice(1)
    : querystring
  try {
    for (const part of rawQuery.split('&')) {
      decodeURIComponent(part)
    }
  } catch {
    return { boundary: null, tab: 'overview', valid: false }
  }
  const params = new URLSearchParams(rawQuery)
  const identifiers = params.getAll('boundary')
  const boundary =
    identifiers.length === 1 && identifiers[0] !== '' ? identifiers[0] : null
  const requestedTab = params.get('tab')
  const tab: BoundaryTab = BOUNDARY_TABS.includes(requestedTab as BoundaryTab)
    ? (requestedTab as BoundaryTab)
    : 'overview'
  return { boundary, tab, valid: boundary !== null }
}

export function boundaryDetailHref(
  boundary: string,
  tab?: BoundaryTab,
): string {
  const selectedTab = tab ?? 'overview'
  const params = new URLSearchParams({ boundary, tab: selectedTab })
  return `#/boundaries/detail?${params.toString()}`
}

export type MembershipOperation = { type: 'add' } | { type: 'remove' }

export interface MembershipBoundarySnapshot {
  boundary: string
  revision: number
  status: 'active' | 'deactivating' | 'inactive'
  reserved: boolean
}

export interface MembershipEnrollmentSnapshot {
  did: string
  enrolled: boolean
  active?: boolean
  boundaries: string[]
  uncertainBoundaries?: string[]
}

export interface MembershipSnapshot {
  lookupIdentity: string
  boundary: MembershipBoundarySnapshot
  enrollment: MembershipEnrollmentSnapshot
}

export type MembershipUnavailableReason =
  | 'target-mismatch'
  | 'unenrolled'
  | 'already-member'
  | 'not-member'
  | 'reserved-boundary'
  | 'boundary-not-active'
  | 'reconciliation-required'

export type MembershipAvailability =
  | { available: true }
  | { available: false; reason: MembershipUnavailableReason }

export interface MembershipPreview {
  targetDid: string
  boundary: string
  operation: MembershipOperation
  wasMember: boolean
  enrolled: boolean
  active: boolean | undefined
  revision: number
  status: MembershipBoundarySnapshot['status']
  reserved: boolean
  lookupIdentity: string
}

export function getMembershipAvailability(
  operation: MembershipOperation,
  snapshot: MembershipSnapshot,
): MembershipAvailability {
  const { boundary, enrollment, lookupIdentity } = snapshot
  if (lookupIdentity !== enrollment.did) {
    return { available: false, reason: 'target-mismatch' }
  }
  if (enrollment.uncertainBoundaries?.includes(boundary.boundary)) {
    return { available: false, reason: 'reconciliation-required' }
  }
  if (!enrollment.enrolled) {
    return { available: false, reason: 'unenrolled' }
  }
  const isMember = enrollment.boundaries.includes(boundary.boundary)
  if (operation.type === 'add') {
    if (boundary.status !== 'active') {
      return { available: false, reason: 'boundary-not-active' }
    }
    if (isMember) return { available: false, reason: 'already-member' }
    return { available: true }
  }
  if (boundary.reserved) {
    return { available: false, reason: 'reserved-boundary' }
  }
  if (!isMember) return { available: false, reason: 'not-member' }
  return { available: true }
}

export function createMembershipPreview(
  operation: MembershipOperation,
  snapshot: MembershipSnapshot,
): MembershipPreview | null {
  if (!getMembershipAvailability(operation, snapshot).available) return null
  const { boundary, enrollment, lookupIdentity } = snapshot
  return {
    targetDid: enrollment.did,
    boundary: boundary.boundary,
    operation,
    wasMember: enrollment.boundaries.includes(boundary.boundary),
    enrolled: enrollment.enrolled,
    active: enrollment.active,
    revision: boundary.revision,
    status: boundary.status,
    reserved: boundary.reserved,
    lookupIdentity,
  }
}

export function membershipPreviewMatches(
  preview: MembershipPreview,
  snapshot: MembershipSnapshot,
): boolean {
  const { boundary, enrollment, lookupIdentity } = snapshot
  return (
    preview.targetDid === enrollment.did &&
    preview.lookupIdentity === lookupIdentity &&
    preview.boundary === boundary.boundary &&
    preview.revision === boundary.revision &&
    preview.status === boundary.status &&
    preview.reserved === boundary.reserved &&
    preview.enrolled === enrollment.enrolled &&
    preview.active === enrollment.active &&
    preview.wasMember === enrollment.boundaries.includes(boundary.boundary)
  )
}
