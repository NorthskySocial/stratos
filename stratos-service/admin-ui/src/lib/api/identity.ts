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

async function fetchDoc(did: string): Promise<string | null> {
  let url: string
  if (did.startsWith('did:plc:')) {
    url = `${PLC_DIRECTORY}/${did}`
  } else if (did.startsWith('did:web:')) {
    const host = decodeURIComponent(did.slice('did:web:'.length))
    if (host.includes(':') && !/^[a-z0-9.-]+:\d+$/.test(host)) return null
    url = `https://${host}/.well-known/did.json`
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
