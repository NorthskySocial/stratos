const ROOM_ROUTE = /^\/rooms\/([^/?#]+)\/?$/

/** Build the durable room route. Only the public feed ID enters the URL. */
export function roomPath(roomId: string): string {
  const trimmed = roomId.trim()
  if (!trimmed) throw new Error('A room ID is required')
  return `/rooms/${encodeURIComponent(trimmed)}`
}

/** Read a room ID from a pathname without interpreting any boundary value. */
export function roomIdFromPath(pathname: string): string | null {
  const match = ROOM_ROUTE.exec(pathname.split('?', 1)[0] ?? '')
  if (!match) return null
  try {
    const id = decodeURIComponent(match[1])
    return id || null
  } catch {
    return null
  }
}

/** Build a shareable topic URL while keeping the authoritative AT URI intact. */
export function topicPath(roomId: string, topicUri: string): string {
  if (!topicUri.startsWith('at://'))
    throw new Error('A topic AT URI is required')
  return `${roomPath(roomId)}?topic=${encodeURIComponent(topicUri)}`
}

/** Read the selected topic AT URI from a room URL. */
export function topicUriFromPath(path: string): string | null {
  const query = path.indexOf('?')
  if (query < 0 || !roomIdFromPath(path)) return null
  const topic = new URLSearchParams(path.slice(query + 1)).get('topic')
  return topic?.startsWith('at://') ? topic : null
}
