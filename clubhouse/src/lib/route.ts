import { parseRecordAddress } from '@northskysocial/stratos-client'

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

/** Build a shareable topic URL while keeping the authoritative record address intact. */
export function topicPath(roomId: string, topicUri: string): string {
  if (!parseRecordAddress(topicUri).ok)
    throw new Error('A topic record address is required')
  return `${roomPath(roomId)}?topic=${encodeURIComponent(topicUri)}`
}

function topicParam(path: string): string | null {
  const query = path.indexOf('?')
  if (query < 0 || !roomIdFromPath(path)) return null
  return new URLSearchParams(path.slice(query + 1)).get('topic')
}

/** Read the selected topic record address from a room URL; null when absent or refused. */
export function topicUriFromPath(path: string): string | null {
  const topic = topicParam(path)
  return topic !== null && parseRecordAddress(topic).ok ? topic : null
}

/** A room URL carries a topic value that is not a record address. */
export function topicLinkIsRefused(path: string): boolean {
  const topic = topicParam(path)
  return topic !== null && !parseRecordAddress(topic).ok
}
