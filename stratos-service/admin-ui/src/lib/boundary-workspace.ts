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
