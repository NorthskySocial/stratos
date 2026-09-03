import type { RoomCatalogEntry } from './types'

export class RoomCatalogError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RoomCatalogError'
  }
}

function isRoomEntry(value: unknown): value is RoomCatalogEntry {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    item.id.trim().length > 0 &&
    typeof item.displayName === 'string' &&
    typeof item.description === 'string' &&
    typeof item.available === 'boolean'
  )
}

/** Parse only the public fields returned by GET /oauth/boundaries. */
export function parseRoomCatalog(payload: unknown): RoomCatalogEntry[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new RoomCatalogError('Room catalogue response was not an object')
  }

  const rooms = (payload as { rooms?: unknown }).rooms
  if (!Array.isArray(rooms) || !rooms.every(isRoomEntry)) {
    throw new RoomCatalogError(
      'Room catalogue response did not contain valid rooms',
    )
  }

  return rooms.map(({ id, displayName, description, available }) => ({
    id,
    displayName,
    description,
    available,
  }))
}

export type CatalogFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export async function fetchRoomCatalog(
  fetcher: CatalogFetch = globalThis.fetch,
  endpoint = '/oauth/boundaries',
): Promise<RoomCatalogEntry[]> {
  let response: Response
  try {
    response = await fetcher(endpoint, {
      headers: { Accept: 'application/json' },
    })
  } catch (error) {
    throw new RoomCatalogError('Room catalogue could not be reached', {
      cause: error,
    })
  }

  if (!response.ok) {
    throw new RoomCatalogError(
      `Room catalogue returned HTTP ${response.status}`,
    )
  }

  try {
    return parseRoomCatalog(await response.json())
  } catch (error) {
    if (error instanceof RoomCatalogError) throw error
    throw new RoomCatalogError('Room catalogue returned invalid JSON', {
      cause: error,
    })
  }
}
