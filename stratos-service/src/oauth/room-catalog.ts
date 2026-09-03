import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { StratosError } from '@northskysocial/stratos-core'
import { parse as parseYaml } from 'yaml'

/** Operator-approved room metadata. This is display data, never an auth claim. */
export interface RoomDescription {
  id: string
  boundary: string
  displayName: string
  description: string
  /** Whether new members may currently join this configured room. */
  available: boolean
}

export interface RoomCatalog {
  list: () => RoomDescription[]
  get: (id: string) => RoomDescription | undefined
}

/** Raised when the deployment-owned public room catalogue is invalid. */
export class InvalidRoomCatalogError extends StratosError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'InvalidRoomCatalog', options)
    this.name = 'InvalidRoomCatalogError'
  }
}

/**
 * Load the deployment-owned catalogue shared with Feedgen. Boundaries must
 * already be service-qualified; configuration owns qualification, not this file.
 */
export function loadRoomCatalog(
  filePath: string,
  allowedBoundaries: readonly string[],
): RoomCatalog {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new InvalidRoomCatalogError(
      `Room catalog could not be read: ${filePath}`,
      { cause: err },
    )
  }
  const format = catalogFormat(filePath)
  let parsed: unknown
  try {
    parsed = format === 'yaml' ? parseYaml(raw) : JSON.parse(raw)
  } catch (err) {
    const parseMessage = err instanceof Error ? err.message : String(err)
    throw new InvalidRoomCatalogError(
      `Room catalog is not valid ${format.toUpperCase()}: ${parseMessage}`,
      { cause: err },
    )
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { feeds?: unknown }).feeds)
  ) {
    throw new InvalidRoomCatalogError(
      'Room catalog must be an object with a "feeds" array',
    )
  }

  const rooms = (parsed as { feeds: unknown[] }).feeds.map((feed, index) =>
    validateRoom(feed, index, allowedBoundaries),
  )
  return buildRoomCatalog(rooms)
}

export function buildRoomCatalog(rooms: RoomDescription[]): RoomCatalog {
  const byId = new Map<string, RoomDescription>()
  const boundaries = new Set<string>()
  for (const room of rooms) {
    if (byId.has(room.id)) {
      throw new InvalidRoomCatalogError(`Duplicate room id: ${room.id}`)
    }
    if (boundaries.has(room.boundary)) {
      throw new InvalidRoomCatalogError(
        `Duplicate room boundary: ${room.boundary}`,
      )
    }
    byId.set(room.id, room)
    boundaries.add(room.boundary)
  }
  return {
    list: () => [...byId.values()],
    get: (id) => byId.get(id),
  }
}

function catalogFormat(filePath: string): 'json' | 'yaml' {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.json') return 'json'
  if (ext === '.yaml' || ext === '.yml') return 'yaml'
  throw new InvalidRoomCatalogError(
    `Unsupported room catalog extension: ${ext} (expected .json, .yaml, or .yml)`,
  )
}

function validateRoom(
  entry: unknown,
  index: number,
  allowedBoundaries: readonly string[],
): RoomDescription {
  if (typeof entry !== 'object' || entry === null) {
    throw new InvalidRoomCatalogError(`feeds[${index}] is not an object`)
  }
  const room = entry as Record<string, unknown>
  const id = requiredString(room, 'id', index)
  const boundary = requiredString(room, 'boundary', index)
  const displayName = requiredString(room, 'displayName', index)
  const description = requiredString(room, 'description', index)
  const available = optionalBoolean(room, 'available', index)
  if (!allowedBoundaries.includes(boundary)) {
    throw new InvalidRoomCatalogError(
      `feeds[${index}].boundary is not an allowed Stratos boundary`,
    )
  }
  return { id, boundary, displayName, description, available }
}

function requiredString(
  room: Record<string, unknown>,
  key: string,
  index: number,
): string {
  const value = room[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRoomCatalogError(
      `feeds[${index}].${key} is required (nonblank string)`,
    )
  }
  return value
}

function optionalBoolean(
  room: Record<string, unknown>,
  key: string,
  index: number,
): boolean {
  const value = room[key]
  if (value === undefined) return true
  if (typeof value !== 'boolean') {
    throw new InvalidRoomCatalogError(
      `feeds[${index}].${key} must be a boolean when present`,
    )
  }
  return value
}
