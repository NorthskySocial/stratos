import {
  parseQualifiedBoundary,
  boundaryToSpaceUri,
} from '@northskysocial/stratos-core'

export interface CatalogBoundary {
  boundary: string
  roomId: string
  displayName: string
  description: string
  listed: boolean
  joinable: boolean
  revision: number
}

export const MAX_CATALOG_BOUNDARIES = 1_000
export const MAX_CATALOG_BYTES = 1_048_576

export function parseBoundaryCatalog(
  value: unknown,
  authority: string,
): CatalogBoundary[] {
  const rows = (value as { boundaries?: unknown } | null)?.boundaries
  if (!Array.isArray(rows) || rows.length > MAX_CATALOG_BOUNDARIES)
    throw new Error('Invalid boundary catalogue')
  const ids = new Set<string>()
  const boundaries = new Set<string>()
  return rows
    .map((value: unknown) => {
      if (value === null || typeof value !== 'object')
        throw new Error('Invalid catalogue entry')
      const row = value as Record<string, unknown>
      const boundary = row['boundary']
      const roomId = row['roomId']
      if (
        typeof boundary !== 'string' ||
        parseQualifiedBoundary(boundary)?.serviceDid !== authority ||
        !boundaryToSpaceUri(boundary, 'zone.stratos.space.feed').ok
      )
        throw new Error('Invalid catalogue boundary authority')
      if (typeof roomId !== 'string' || roomId.trim().length === 0)
        throw new Error('Invalid catalogue room ID')
      validateMetadata(row)
      if (ids.has(roomId) || boundaries.has(boundary))
        throw new Error('Duplicate catalogue mapping')
      ids.add(roomId)
      boundaries.add(boundary)
      return {
        boundary,
        roomId,
        displayName: row['displayName'],
        description: row['description'],
        listed: row['listed'],
        joinable: row['joinable'],
        revision: row['revision'],
      }
    })
    .sort((a, b) => a.roomId.localeCompare(b.roomId))
}

function validateMetadata(
  row: Record<string, unknown>,
): asserts row is Record<string, unknown> &
  Omit<CatalogBoundary, 'boundary' | 'roomId'> {
  if (
    typeof row['displayName'] !== 'string' ||
    typeof row['description'] !== 'string' ||
    typeof row['listed'] !== 'boolean' ||
    typeof row['joinable'] !== 'boolean' ||
    !Number.isSafeInteger(row['revision']) ||
    (row['revision'] as number) < 1
  )
    throw new Error('Invalid catalogue metadata')
}
