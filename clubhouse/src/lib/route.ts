const ROOM_ROUTE = /^\/rooms\/([^/?#]+)\/?$/

/** Build the durable room route. Only the public feed ID enters the URL. */
export function roomPath(roomId: string): string {
  const trimmed = roomId.trim()
  if (!trimmed) throw new Error('A room ID is required')
  return `/rooms/${encodeURIComponent(trimmed)}`
}

/** Read a room ID from a pathname without interpreting any boundary value. */
export function roomIdFromPath(pathname: string): string | null {
  const match = ROOM_ROUTE.exec(pathname)
  if (!match) return null
  try {
    const id = decodeURIComponent(match[1])
    return id || null
  } catch {
    return null
  }
}
