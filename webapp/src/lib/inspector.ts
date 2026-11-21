import type { OAuthSession } from '@atproto/oauth-client-browser'
import {
  parseRecordAddress,
  type SpaceRecordAddress,
} from '@northskysocial/stratos-client'

interface CustodyUriParts {
  did: string
  collection: string
  rkey: string
}

export interface InspectorResult {
  stub: Record<string, unknown> | null
  record: Record<string, unknown> | null
  stubError: string | null
  stubNotFound: boolean
  recordError: string | null
}

/**
 * Splits a custody record URI. Only the custody path calls this, after the
 * address has been classified as a custody record.
 */
function parseCustodyUri(uri: string): CustodyUriParts {
  const [did = '', collection = '', rkey = ''] = uri
    .replace('at://', '')
    .split('/')
  return { did, collection, rkey }
}

/**
 * Resolves a DID to a PDS endpoint URL.
 * @param did - the DID to resolve
 * @returns a promise that resolves to the PDS endpoint URL
 * @throws an error if the resolution fails
 */
export async function resolvePdsEndpoint(did: string): Promise<string> {
  if (did.startsWith('did:plc:')) {
    const res = await fetch(`https://plc.directory/${encodeURIComponent(did)}`)
    if (!res.ok) throw new Error(`PLC directory lookup failed: ${res.status}`)
    const doc = await res.json()
    const pds = doc.service?.find(
      (s: { id?: string }) => s.id === '#atproto_pds',
    )
    if (!pds?.serviceEndpoint)
      throw new Error('No PDS endpoint in DID document')
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
    if (!pds?.serviceEndpoint)
      throw new Error('No PDS endpoint in DID document')
    return pds.serviceEndpoint
  }

  throw new Error(`Unsupported DID method: ${did}`)
}

/**
 * Fetches a record stub from a PDS endpoint.
 * @param pdsUrl - the PDS endpoint URL
 * @param did - the DID of the record owner
 * @param collection - the collection name of the record
 * @param rkey - the record key
 * @returns a promise that resolves to the record stub
 */
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

/**
 * Fetches a hydrated record from a Stratos service.
 * @param session - the OAuth session
 * @param stratosUrl - the Stratos service URL
 * @param uri - the AT URI of the record
 * @returns a promise that resolves to the hydrated record
 */
export async function fetchHydratedRecord(
  session: OAuthSession,
  stratosUrl: string,
  uri: string,
): Promise<Record<string, unknown>> {
  const { did, collection, rkey } = parseCustodyUri(uri)
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

/**
 * Fetches a record stub and hydrates it from a Stratos service.
 * @param session - the OAuth session
 * @param stratosUrl - the Stratos service URL
 * @param uri - the AT URI of the record
 * @returns a promise that resolves to the hydrated record
 */
export async function inspectRecord(
  session: OAuthSession,
  stratosUrl: string,
  uri: string,
): Promise<InspectorResult> {
  const result: InspectorResult = {
    stub: null,
    record: null,
    stubError: null,
    stubNotFound: false,
    recordError: null,
  }

  const { did, collection, rkey } = parseCustodyUri(uri)

  try {
    const pdsUrl = await resolvePdsEndpoint(did)
    result.stub = await fetchPdsStub(pdsUrl, did, collection, rkey)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('RecordNotFound') || msg.includes('404')) {
      result.stubNotFound = true
    } else {
      result.stubError = msg
    }
  }

  try {
    result.record = await fetchHydratedRecord(session, stratosUrl, uri)
  } catch (err) {
    result.recordError = err instanceof Error ? err.message : String(err)
  }

  return result
}

/** Where the inspector gets a record from, chosen by who wrote it and where it lives. */
export type InspectorSource =
  | 'custody'
  | 'own-space'
  | 'feed-snapshot'
  | 'invalid'

/** What the inspector knows about a post the feed already served. */
export interface InspectorEntry {
  uri: string
  cid: string
  /** The record exactly as the feed served it, when the feed kept it. */
  record?: Record<string, unknown>
  indexedAt?: string
}

export interface FeedSnapshot {
  uri: string
  cid: string
  record: Record<string, unknown>
  indexedAt: string | null
}

export type SpaceRecordErrorName =
  | 'InvalidSpaceMac'
  | 'RecordNotFound'
  | 'SpaceNotFound'
  | 'RepoNotFound'
  | 'RepoTakendown'
  | 'RepoSuspended'
  | 'RepoDeactivated'

const SPACE_RECORD_ERROR_NAMES: readonly string[] = [
  'InvalidSpaceMac',
  'RecordNotFound',
  'SpaceNotFound',
  'RepoNotFound',
  'RepoTakendown',
  'RepoSuspended',
  'RepoDeactivated',
] satisfies SpaceRecordErrorName[]

export type OwnSpaceRead =
  | { kind: 'found'; uri: string; cid: string; value: unknown }
  | { kind: 'unauthorized' }
  | { kind: 'error'; status: number; name: SpaceRecordErrorName | null }
  | { kind: 'unreachable' }
  /** The read stopped before any answer could be judged. */
  | { kind: 'failed' }

export type InspectorOutcome =
  | { source: 'custody'; result: InspectorResult }
  | { source: 'own-space'; read: OwnSpaceRead }
  | { source: 'feed-snapshot'; snapshot: FeedSnapshot | null }
  | { source: 'invalid' }

function sourceOfAddress(
  address: ReturnType<typeof parseRecordAddress>,
  viewerDid: string,
): InspectorSource {
  if (!address.ok) return 'invalid'
  if (address.value.kind === 'custody') return 'custody'
  return address.value.author === viewerDid ? 'own-space' : 'feed-snapshot'
}

/**
 * Chooses where the inspector reads a post from. Only a space record the
 * signed-in account wrote may be read from the PDS with that account's
 * session; another author's space record is shown from the feed entry.
 */
export function chooseInspectorSource(
  entry: Pick<InspectorEntry, 'uri'>,
  viewerDid: string,
): InspectorSource {
  return sourceOfAddress(parseRecordAddress(entry.uri), viewerDid)
}

function spaceRecordErrorName(value: unknown): SpaceRecordErrorName | null {
  return typeof value === 'string' && SPACE_RECORD_ERROR_NAMES.includes(value)
    ? (value as SpaceRecordErrorName)
    : null
}

/**
 * Reads one of the signed-in account's own space records from its own PDS.
 * The PDS answers an account credential for that account's repo only.
 */
export async function readOwnSpaceRecord(
  session: OAuthSession,
  address: SpaceRecordAddress,
): Promise<OwnSpaceRead> {
  const parameters = new URLSearchParams({
    space: `at:space/${address.authority}/${address.spaceType}/${address.skey}`,
    repo: address.author,
    collection: address.collection,
    rkey: address.rkey,
  })
  let response: Response
  try {
    response = await session.fetchHandler(
      `/xrpc/com.atproto.space.getRecord?${parameters}`,
      { method: 'GET' },
    )
  } catch {
    return { kind: 'unreachable' }
  }
  if (response.status === 401) return { kind: 'unauthorized' }
  const body: unknown = await response.json().catch(() => undefined)
  const fields =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {}
  if (
    response.ok &&
    typeof fields.uri === 'string' &&
    typeof fields.cid === 'string' &&
    'value' in fields
  ) {
    return {
      kind: 'found',
      uri: fields.uri,
      cid: fields.cid,
      value: fields.value,
    }
  }
  return {
    kind: 'error',
    status: response.status,
    name: response.ok ? null : spaceRecordErrorName(fields.error),
  }
}

/** The copy the feed already served, or null when the feed kept no record. */
export function snapshotFromEntry(entry: InspectorEntry): FeedSnapshot | null {
  if (!entry.record) return null
  return {
    uri: entry.uri,
    cid: entry.cid,
    record: entry.record,
    indexedAt: entry.indexedAt ?? null,
  }
}

/**
 * Loads what the inspector shows for a feed entry. Another author's space
 * record and an invalid address send no request.
 */
export async function loadInspectorRecord(
  session: OAuthSession,
  stratosUrl: string,
  entry: InspectorEntry,
): Promise<InspectorOutcome> {
  const address = parseRecordAddress(entry.uri)
  const source = sourceOfAddress(address, session.sub)
  if (source === 'custody') {
    return {
      source,
      result: await inspectRecord(session, stratosUrl, entry.uri),
    }
  }
  if (source === 'own-space' && address.ok && address.value.kind === 'space') {
    return { source, read: await readOwnSpaceRecord(session, address.value) }
  }
  if (source === 'feed-snapshot') {
    return { source, snapshot: snapshotFromEntry(entry) }
  }
  return { source: 'invalid' }
}

/**
 * Escapes HTML special characters in a string.
 * @param str - the string to escape
 * @returns the escaped string
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Syntax highlights a JSON object.
 * @param obj - the JSON object to highlight
 * @param indent - the indentation level (default: 0)
 * @returns the syntax-highlighted JSON string
 */
export function syntaxHighlightJson(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)
  const padInner = '  '.repeat(indent + 1)

  if (obj === null) return '<span class="json-null">null</span>'
  if (obj === undefined) return '<span class="json-null">undefined</span>'
  if (typeof obj === 'boolean') return `<span class="json-bool">${obj}</span>`
  if (typeof obj === 'number') return `<span class="json-num">${obj}</span>`
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
