/**
 * DID → handle resolution for admin display.
 *
 * Reads the DID document (plc.directory for did:plc, /.well-known/did.json
 * for did:web) and takes the first valid `at://` entry in `alsoKnownAs` as
 * the canonical handle. Display-only: the browser cannot do the DNS half of
 * bidirectional verification, so treat the result as a convenience label,
 * not a verified identity.
 */

const PLC_DIRECTORY = 'https://plc.directory'

const PLC_DID_RE = /^did:plc:[a-z2-7]{24}$/
const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/
const PORT_RE = /^\d{1,5}$/
const PATH_SEGMENT_RE = /^[a-zA-Z0-9._~-]+$/

interface DidDocument {
  id?: string
  alsoKnownAs?: string[]
}

const cache = new Map<string, Promise<string | null>>()

function handleFromDoc(did: string, doc: DidDocument): string | null {
  if (doc.id !== undefined && doc.id !== did) return null
  for (const aka of doc.alsoKnownAs ?? []) {
    if (aka.startsWith('at://')) {
      const handle = aka.slice('at://'.length).trim().toLowerCase()
      if (/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(handle)) return handle
    }
  }
  return null
}

/**
 * Build the DID-document URL for a did:web, or null if the method-specific ID
 * is not a safe host[:port][:path…] identifier. Segments are validated and
 * re-encoded individually so attacker-controlled DIDs cannot smuggle `/`,
 * `?`, `#`, or `@` into the request URL and steer the operator's browser at
 * arbitrary local-network paths.
 */
function didWebUrl(did: string): string | null {
  const segments = did.slice('did:web:'.length).split(':')
  const hostSegment = segments.shift()
  if (!hostSegment) return null

  let host = decodeURIComponent(hostSegment)
  if (segments.length > 0 && PORT_RE.test(decodeURIComponent(segments[0]))) {
    host += `:${decodeURIComponent(segments.shift()!)}`
  }
  const bareHost = host.split(':')[0]
  if (!HOSTNAME_RE.test(bareHost) && bareHost !== 'localhost') return null

  if (segments.length === 0) {
    return `https://${host}/.well-known/did.json`
  }
  const parts: string[] = []
  for (const segment of segments) {
    const decoded = decodeURIComponent(segment)
    if (!PATH_SEGMENT_RE.test(decoded)) return null
    parts.push(encodeURIComponent(decoded))
  }
  return `https://${host}/${parts.join('/')}/did.json`
}

async function fetchDoc(did: string): Promise<string | null> {
  let url: string
  if (PLC_DID_RE.test(did)) {
    url = `${PLC_DIRECTORY}/${did}`
  } else if (did.startsWith('did:web:')) {
    const webUrl = didWebUrl(did)
    if (!webUrl) return null
    url = webUrl
  } else {
    return null
  }

  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return handleFromDoc(did, (await res.json()) as DidDocument)
  } catch {
    return null
  }
}

export function resolveHandle(did: string): Promise<string | null> {
  let pending = cache.get(did)
  if (!pending) {
    pending = fetchDoc(did)
    cache.set(did, pending)
    // Do not cache failures; a retry may succeed.
    void pending.then((handle) => {
      if (handle === null) cache.delete(did)
    })
  }
  return pending
}

/**
 * Handle → DID via the public Bluesky AppView (CORS-enabled; the browser
 * cannot query DNS TXT records itself). Used so admins can search by handle.
 */
export async function resolveDid(handle: string): Promise<string | null> {
  const normalized = handle
    .trim()
    .toLowerCase()
    .replace(/^at:\/\//, '')
    .replace(/^@/, '')
  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(normalized)}`,
    )
    if (!res.ok) return null
    const body = (await res.json()) as { did?: string }
    return body.did?.startsWith('did:') ? body.did : null
  } catch {
    return null
  }
}
