import { verifyRecord } from 'npm:@atcute/repo'

export const PDS_SPACES_URL = 'http://localhost:3010'
export const PDS_SPACES_ADMIN_PASSWORD = 'spaces-test-admin'
export const SPACE_DECLARATION_COLLECTION = 'com.atproto.lexicon.schema'
export const SPACE_DECLARATION_RKEY = 'zone.stratos.space.feed'
export const SPACE_POST_COLLECTION = 'zone.stratos.feed.post'
export const ENROLLMENT_COLLECTION = 'zone.stratos.actor.enrollment'

export interface PdsSession {
  did: string
  handle: string
  accessJwt: string
}

interface Account extends PdsSession {}

interface InviteCodeResponse {
  code: string
}

export interface PdsSpaceAccount {
  did: string
  handle: string
  password: string
}

export interface SpaceRecord {
  uri: string
  cid: string
}

export interface PdsSpaceRecord extends SpaceRecord {
  value: Record<string, unknown>
}

export async function waitForPdsSpacesReady(
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastFailure = 'not reachable'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${PDS_SPACES_URL}/xrpc/_health`)
      if (response.ok) {
        await response.body?.cancel()
        return
      }
      lastFailure = `status ${response.status}`
      await response.body?.cancel()
    } catch (error) {
      lastFailure = String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(
    `spaces PDS did not become ready within ${timeoutMs}ms: ${lastFailure}`,
  )
}

function adminAuthorization(): string {
  return `Basic ${btoa(`admin:${PDS_SPACES_ADMIN_PASSWORD}`)}`
}

async function jsonResponse<T>(res: Response, label: string): Promise<T> {
  if (res.ok) return (await res.json()) as T
  throw new Error(`${label} failed: ${res.status} ${await res.text()}`)
}

export async function createPdsInviteCode(): Promise<string> {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await createPdsInviteCodeOnce()
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw new Error(
    `spaces PDS did not accept invite creation: ${String(lastError)}`,
  )
}

async function createPdsInviteCodeOnce(): Promise<string> {
  const res = await fetch(
    `${PDS_SPACES_URL}/xrpc/com.atproto.server.createInviteCode`,
    {
      method: 'POST',
      headers: {
        authorization: adminAuthorization(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ useCount: 1 }),
    },
  )
  return (await jsonResponse<InviteCodeResponse>(res, 'create invite code'))
    .code
}

export async function createPdsAccount(
  handle: string,
  email: string,
  password: string,
): Promise<PdsSpaceAccount> {
  const inviteCode = await createPdsInviteCode()
  const res = await fetch(
    `${PDS_SPACES_URL}/xrpc/com.atproto.server.createAccount`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle, email, password, inviteCode }),
    },
  )
  const account = await jsonResponse<Account>(res, `create account ${handle}`)
  return { did: account.did, handle: account.handle, password }
}

export async function createPdsSession(
  identifier: string,
  password: string,
): Promise<PdsSession> {
  const res = await fetch(
    `${PDS_SPACES_URL}/xrpc/com.atproto.server.createSession`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    },
  )
  return await jsonResponse<PdsSession>(res, `create session ${identifier}`)
}

export async function createPdsSpaceRecord(
  session: PdsSession,
  space: string,
  record: Record<string, unknown>,
  rkey?: string,
): Promise<SpaceRecord> {
  const body: Record<string, unknown> = {
    space,
    repo: session.did,
    collection: SPACE_POST_COLLECTION,
    record,
  }
  if (rkey) body.rkey = rkey
  const res = await fetch(
    `${PDS_SPACES_URL}/xrpc/com.atproto.space.createRecord`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.accessJwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )
  return await jsonResponse<SpaceRecord>(res, 'create space record')
}

export async function getPdsSpaceRecord(
  session: PdsSession,
  space: string,
  repo: string,
  collection: string,
  rkey: string,
): Promise<PdsSpaceRecord> {
  const params = new URLSearchParams({ space, repo, collection, rkey })
  const res = await fetch(
    `${PDS_SPACES_URL}/xrpc/com.atproto.space.getRecord?${params}`,
    { headers: { authorization: `Bearer ${session.accessJwt}` } },
  )
  return await jsonResponse<PdsSpaceRecord>(res, 'get space record')
}

export function parseSpaceRecordUri(
  uri: string,
  space: string,
): {
  did: string
  collection: string
  rkey: string
} {
  const prefix = `${space}/`
  if (!uri.startsWith(prefix)) {
    throw new Error(`space record does not belong to ${space}: ${uri}`)
  }
  const parts = uri.slice(prefix.length).split('/')
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error(`invalid space record URI: ${uri}`)
  }
  const [did, collection, rkey] = parts
  return { did, collection, rkey }
}

export async function verifyPdsRecord(
  endpoint: string,
  did: string,
  collection: string,
  rkey: string,
): Promise<unknown> {
  const params = new URLSearchParams({
    did,
    collection,
    rkey,
  })
  const res = await fetch(
    `${endpoint}/xrpc/com.atproto.sync.getRecord?${params}`,
  )
  if (!res.ok) {
    throw new Error(
      `get record proof failed: ${res.status} ${await res.text()}`,
    )
  }
  const verified = await verifyRecord({
    carBytes: new Uint8Array(await res.arrayBuffer()),
    did: did as `did:plc:${string}` | `did:web:${string}`,
    collection,
    rkey,
  })
  return verified.record
}

export async function verifyPdsSpaceDeclaration(
  endpoint: string,
  did: string,
): Promise<unknown> {
  return await verifyPdsRecord(
    endpoint,
    did,
    SPACE_DECLARATION_COLLECTION,
    SPACE_DECLARATION_RKEY,
  )
}
