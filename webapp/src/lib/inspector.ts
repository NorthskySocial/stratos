import type { OAuthSession } from '@atproto/oauth-client-browser'

export interface AtUriParts {
  did: string
  collection: string
  rkey: string
}

export interface InspectorResult {
  stub: Record<string, unknown> | null
  record: Record<string, unknown> | null
  stubError: string | null
  recordError: string | null
}

export function parseAtUri(uri: string): AtUriParts {
  const stripped = uri.replace('at://', '')
  const [did, collection, rkey] = stripped.split('/')
  return { did, collection, rkey }
}

export async function resolvePdsEndpoint(did: string): Promise<string> {
  if (did.startsWith('did:plc:')) {
    const res = await fetch(`https://plc.directory/${encodeURIComponent(did)}`)
    if (!res.ok) throw new Error(`PLC directory lookup failed: ${res.status}`)
    const doc = await res.json()
    const pds = doc.service?.find(
      (s: { id?: string }) => s.id === '#atproto_pds',
    )
    if (!pds?.serviceEndpoint) throw new Error('No PDS endpoint in DID document')
    return pds.serviceEndpoint
  }

  if (did.startsWith('did:web:')) {
    const domain = did.slice('did:web:'.length)
    const res = await fetch(`https://${domain}/.well-known/did.json`)
    if (!res.ok) throw new Error(`did:web resolution failed: ${res.status}`)
    const doc = await res.json()
    const pds = doc.service?.find(
      (s: { id?: string }) => s.id === '#atproto_pds',
    )
    if (!pds?.serviceEndpoint) throw new Error('No PDS endpoint in DID document')
    return pds.serviceEndpoint
  }

  throw new Error(`Unsupported DID method: ${did}`)
}

export async function fetchPdsStub(
  pdsUrl: string,
  did: string,
  collection: string,
  rkey: string,
): Promise<Record<string, unknown>> {
  const url = new URL('/xrpc/com.atproto.repo.getRecord', pdsUrl)
  url.searchParams.set('repo', did)
  url.searchParams.set('collection', collection)
  url.searchParams.set('rkey', rkey)

  const res = await fetch(url.href)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`PDS getRecord failed: ${res.status} ${text}`)
  }
  return res.json()
}

export async function fetchHydratedRecord(
  session: OAuthSession,
  stratosUrl: string,
  uri: string,
): Promise<Record<string, unknown>> {
  const { did, collection, rkey } = parseAtUri(uri)
  const url = new URL('/xrpc/com.atproto.repo.getRecord', stratosUrl)
  url.searchParams.set('repo', did)
  url.searchParams.set('collection', collection)
  url.searchParams.set('rkey', rkey)

  const res = await session.fetchHandler(url.href, { method: 'GET' })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Stratos getRecord failed: ${res.status} ${text}`)
  }
  return res.json()
}

export async function inspectRecord(
  session: OAuthSession,
  stratosUrl: string,
  uri: string,
): Promise<InspectorResult> {
  const result: InspectorResult = {
    stub: null,
    record: null,
    stubError: null,
    recordError: null,
  }

  const { did, collection, rkey } = parseAtUri(uri)

  try {
    const pdsUrl = await resolvePdsEndpoint(did)
    const stubResponse = await fetchPdsStub(pdsUrl, did, collection, rkey)
    result.stub = stubResponse as Record<string, unknown>
  } catch (err) {
    result.stubError = err instanceof Error ? err.message : String(err)
  }

  try {
    const hydrateResponse = await fetchHydratedRecord(session, stratosUrl, uri)
    result.record = hydrateResponse as Record<string, unknown>
  } catch (err) {
    result.recordError = err instanceof Error ? err.message : String(err)
  }

  return result
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function syntaxHighlightJson(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)
  const padInner = '  '.repeat(indent + 1)

  if (obj === null) return '<span class="json-null">null</span>'
  if (obj === undefined) return '<span class="json-null">undefined</span>'
  if (typeof obj === 'boolean')
    return `<span class="json-bool">${obj}</span>`
  if (typeof obj === 'number')
    return `<span class="json-num">${obj}</span>`
  if (typeof obj === 'string')
    return `<span class="json-str">"${escapeHtml(obj)}"</span>`

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]'
    const items = obj
      .map((item) => `${padInner}${syntaxHighlightJson(item, indent + 1)}`)
      .join(',\n')
    return `[\n${items}\n${pad}]`
  }

  if (typeof obj === 'object') {
    const entries = Object.entries(obj)
    if (entries.length === 0) return '{}'
    const lines = entries
      .map(
        ([key, val]) =>
          `${padInner}<span class="json-key">"${escapeHtml(key)}"</span>: ${syntaxHighlightJson(val, indent + 1)}`,
      )
      .join(',\n')
    return `{\n${lines}\n${pad}}`
  }

  return escapeHtml(String(obj))
}
