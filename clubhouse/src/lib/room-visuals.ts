import type { IconaMoonName } from './icon-names'
import type { RoomCatalogEntry } from './types'

export type RoomVisualTone =
  | 'amber'
  | 'coral'
  | 'cyan'
  | 'leaf'
  | 'lumen'
  | 'magenta'
  | 'mint'
  | 'orchid'
  | 'sky'
  | 'tangerine'
  | 'violet'
  | 'yellow'

export interface RoomVisual {
  icon: IconaMoonName
  tone: RoomVisualTone
}

export const DEFAULT_ROOM_VISUAL: RoomVisual = {
  icon: 'category',
  tone: 'mint',
}

interface RoomVisualOption extends RoomVisual {
  keywords: readonly string[]
}

const ROOM_VISUAL_OPTIONS: readonly RoomVisualOption[] = [
  {
    icon: 'music',
    tone: 'magenta',
    keywords: ['music', 'dance', 'ball', 'listening', 'record', 'sound'],
  },
  {
    icon: 'camera',
    tone: 'sky',
    keywords: ['art', 'camera', 'film', 'media', 'photo', 'visual'],
  },
  {
    icon: 'comment',
    tone: 'amber',
    keywords: ['chat', 'conversation', 'discuss', 'talk'],
  },
  {
    icon: 'heart',
    tone: 'coral',
    keywords: ['care', 'health', 'heart', 'support', 'wellbeing'],
  },
  {
    icon: 'star',
    tone: 'yellow',
    keywords: ['culture', 'featured', 'night', 'show'],
  },
  {
    icon: 'bookmark',
    tone: 'orchid',
    keywords: ['book', 'learn', 'read', 'study', 'writing'],
  },
  {
    icon: 'lightning',
    tone: 'tangerine',
    keywords: ['action', 'build', 'game', 'project', 'tech'],
  },
  {
    icon: 'shield',
    tone: 'cyan',
    keywords: ['private', 'safety', 'secure', 'trusted'],
  },
  {
    icon: 'gift',
    tone: 'violet',
    keywords: ['celebrate', 'party', 'surprise'],
  },
  {
    icon: 'home',
    tone: 'leaf',
    keywords: ['community', 'house', 'local', 'neighbour'],
  },
  {
    icon: 'clock',
    tone: 'lumen',
    keywords: ['event', 'meet', 'schedule', 'time'],
  },
  {
    icon: 'category',
    tone: 'mint',
    keywords: ['collective', 'general', 'group', 'room'],
  },
]

function stableHash(value: string): number {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function preferredOption(room: RoomCatalogEntry): RoomVisualOption | undefined {
  const searchable =
    `${room.id} ${room.displayName} ${room.description}`.toLowerCase()
  return ROOM_VISUAL_OPTIONS.find((option) =>
    option.keywords.some((keyword) => searchable.includes(keyword)),
  )
}

export function roomVisualsFor(
  rooms: readonly RoomCatalogEntry[],
): ReadonlyMap<string, RoomVisual> {
  const available = [...ROOM_VISUAL_OPTIONS]
  const visuals = new Map<string, RoomVisual>()
  const orderedRooms = [...rooms].sort((left, right) =>
    left.id.localeCompare(right.id),
  )

  for (const room of orderedRooms) {
    const preferred = preferredOption(room)
    const preferredIndex = preferred ? available.indexOf(preferred) : -1
    const optionIndex =
      preferredIndex >= 0
        ? preferredIndex
        : available.length > 0
          ? stableHash(room.id) % available.length
          : stableHash(room.id) % ROOM_VISUAL_OPTIONS.length
    const option =
      available.length > 0
        ? available.splice(optionIndex, 1)[0]
        : ROOM_VISUAL_OPTIONS[optionIndex]

    visuals.set(room.id, { icon: option.icon, tone: option.tone })
  }

  return visuals
}
