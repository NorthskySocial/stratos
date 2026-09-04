const TYPEAHEAD_URL = 'https://typeahead.waow.tech'
const PROFILE_BATCH_SIZE = 25

export interface TypeaheadActor {
  did: string
  handle: string
  displayName?: string
  avatar?: string
}

interface TypeaheadResponse {
  actors?: unknown
  profiles?: unknown
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field]
  return typeof value === 'string' && value ? value : undefined
}

function safeImageUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}

function parseActors(value: unknown): TypeaheadActor[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): TypeaheadActor[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const actor = entry as Record<string, unknown>
    const did = optionalString(actor, 'did')
    const handle = optionalString(actor, 'handle')
    if (!did || !handle) return []
    const displayName = optionalString(actor, 'displayName')
    const avatar = safeImageUrl(optionalString(actor, 'avatar'))
    return [{ did, handle, ...(displayName ? { displayName } : {}), ...(avatar ? { avatar } : {}) }]
  })
}

function requestHeaders(): HeadersInit {
  const client =
    typeof window !== 'undefined' && window.location.host
      ? window.location.host
      : 'northsky-clubhouse'
  return { 'X-Client': client }
}

async function request(
  path: string,
  parameters: URLSearchParams,
  fetcher: typeof fetch,
): Promise<TypeaheadResponse> {
  const response = await fetcher(`${TYPEAHEAD_URL}${path}?${parameters}`, {
    headers: requestHeaders(),
  })
  if (!response.ok) {
    throw new Error(`Actor search returned HTTP ${response.status}.`)
  }
  return (await response.json()) as TypeaheadResponse
}

export async function searchActors(
  query: string,
  fetcher: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<TypeaheadActor[]> {
  const normalized = query.trim()
  if (normalized.length < 2) return []
  const parameters = new URLSearchParams({ q: normalized, limit: '6' })
  const response = await fetcher(
    `${TYPEAHEAD_URL}/xrpc/tech.waow.typeahead.searchActors?${parameters}`,
    { headers: requestHeaders(), signal },
  )
  if (!response.ok) {
    throw new Error(`Actor search returned HTTP ${response.status}.`)
  }
  const payload = (await response.json()) as TypeaheadResponse
  return parseActors(payload.actors)
}

export async function getActorProfiles(
  actors: readonly string[],
  fetcher: typeof fetch = globalThis.fetch,
): Promise<ReadonlyMap<string, TypeaheadActor>> {
  const uniqueActors = [...new Set(actors.filter(Boolean))]
  const profiles = new Map<string, TypeaheadActor>()

  for (let offset = 0; offset < uniqueActors.length; offset += PROFILE_BATCH_SIZE) {
    const parameters = new URLSearchParams()
    for (const actor of uniqueActors.slice(offset, offset + PROFILE_BATCH_SIZE)) {
      parameters.append('actors', actor)
    }
    const payload = await request(
      '/xrpc/app.bsky.actor.getProfiles',
      parameters,
      fetcher,
    )
    for (const profile of parseActors(payload.profiles)) {
      profiles.set(profile.did, profile)
    }
  }

  return profiles
}
