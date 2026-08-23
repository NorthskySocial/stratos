#!/usr/bin/env -S deno run -A
// subscribeRecords consumer test — actor-scoped WebSocket stream.
//
// Connects with a real inter-service JWT minted by the PDS (getServiceAuth),
// the same auth pattern the feedgen uses. Each wire frame is two concatenated
// CBOR values: header {op, t} then the message body. Boundary filtering is
// asserted from the consumer side: a viewer sharing the record's boundary
// receives the commit; a viewer without it receives nothing for that record.

import { WebSocket } from 'npm:ws@^8.19.0'
import { decodeFirst } from 'npm:@atcute/cbor@^2.3.6'

import { DOMAINS, SERVICE_DID, STRATOS_URL } from './lib/config.ts'
import { loadState } from './lib/state.ts'
import { createSession, getServiceAuth } from './lib/pds.ts'
import { createRecord, deleteRecord } from './lib/stratos.ts'
import { assert, fail, finish, info, pass, section } from './lib/log.ts'

const LXM = 'zone.stratos.sync.subscribeRecords'
const COLLECTION = 'zone.stratos.feed.post'

interface FrameHeader {
  op: number
  t?: string
}

interface RecordOp {
  action: string
  path: string
  record?: {
    text?: string
    boundary?: { values?: Array<{ value: string }> }
  }
}

interface CommitBody {
  seq: number
  did: string
  ops: RecordOp[]
}

interface Frame {
  header: FrameHeader
  body: unknown
}

interface StreamClient {
  frames: Frame[]
  closed: boolean
  ready: Promise<void>
  close(): void
}

/** Every op across all #commit frames received so far. */
function commitOps(client: StreamClient): RecordOp[] {
  return client.frames
    .filter((f) => f.header.t === '#commit')
    .flatMap((f) => (f.body as CommitBody).ops ?? [])
}

function openStream(token: string | null, actorDid: string): StreamClient {
  const wsUrl =
    STRATOS_URL.replace(/^http/, 'ws') +
    `/xrpc/${LXM}?did=${encodeURIComponent(actorDid)}`
  const ws = new WebSocket(
    wsUrl,
    token ? { headers: { authorization: `Bearer ${token}` } } : {},
  )
  ws.binaryType = 'arraybuffer'

  const client: StreamClient = {
    frames: [],
    closed: false,
    ready: new Promise<void>((resolve) => {
      ws.onopen = () => resolve()
    }),
    close: () => ws.close(),
  }

  ws.onmessage = (e: { data: ArrayBuffer | Uint8Array }) => {
    const bytes = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data)
    const [header, rest] = decodeFirst(bytes) as [FrameHeader, Uint8Array]
    const [body] = decodeFirst(rest) as [unknown, Uint8Array]
    client.frames.push({ header, body })
  }
  ws.onclose = () => {
    client.closed = true
  }
  ws.onerror = () => {
    client.closed = true
  }
  return client
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return predicate()
}

async function mintSubscribeJwt(
  handle: string,
  password: string,
): Promise<string> {
  const session = await createSession(handle, password)
  return await getServiceAuth(session.accessJwt, SERVICE_DID, LXM)
}

async function run() {
  section('Phase 4e: Sync stream — subscribeRecords consumer')

  const state = await loadState()
  const rei = state.users.rei // author, swordsmith
  const sakura = state.users.sakura // shares swordsmith
  const kaoruko = state.users.kaoruko // aekea only
  if (!rei?.enrolled || !sakura?.enrolled || !kaoruko?.enrolled) {
    fail('Users rei, sakura, kaoruko must be enrolled — run earlier phases')
    finish()
  }

  section('Subscribe with PDS-minted service JWTs')
  let sakuraStream: StreamClient
  let kaorukoStream: StreamClient
  try {
    const [sakuraJwt, kaorukoJwt] = await Promise.all([
      mintSubscribeJwt(sakura.handle, sakura.password),
      mintSubscribeJwt(kaoruko.handle, kaoruko.password),
    ])
    sakuraStream = openStream(sakuraJwt, rei.did)
    kaorukoStream = openStream(kaorukoJwt, rei.did)
    await Promise.all([sakuraStream.ready, kaorukoStream.ready])
    pass('both viewers connected to the actor stream', `actor=${rei.did}`)
  } catch (err) {
    fail('connect to the actor stream', String(err))
    finish()
  }

  section('Create emits a boundary-scoped #commit')
  const text = 'Sango patrols the slayer village at dusk'
  const record = {
    $type: COLLECTION,
    text,
    boundary: { values: [{ value: DOMAINS.swordsmith }] },
    createdAt: new Date().toISOString(),
  }

  let rkey = ''
  try {
    const created = await createRecord(rei.did, COLLECTION, record)
    rkey = created.uri.split('/').pop() ?? ''
    pass('createRecord as rei (swordsmith boundary)', created.uri)
  } catch (err) {
    fail('createRecord as rei (swordsmith boundary)', String(err))
    finish()
  }
  const path = `${COLLECTION}/${rkey}`

  const gotCreate = await waitFor(
    () =>
      commitOps(sakuraStream).some(
        (op) => op.action === 'create' && op.path === path,
      ),
    10_000,
  )
  assert(
    gotCreate,
    'shared-boundary viewer receives the create #commit',
    `path=${path}`,
  )

  const createOp = commitOps(sakuraStream).find(
    (op) => op.action === 'create' && op.path === path,
  )
  assert(
    createOp?.record?.text === text,
    'create op carries the record body',
    `text=${createOp?.record?.text}`,
  )
  const boundaries = (createOp?.record?.boundary?.values ?? []).map(
    (v) => v.value,
  )
  assert(
    boundaries.includes(DOMAINS.swordsmith),
    'record body carries the swordsmith boundary',
    boundaries.join(', '),
  )

  section('Delete emits without leaking the record body')
  try {
    await deleteRecord(rei.did, COLLECTION, rkey)
    pass('deleteRecord as rei')
  } catch (err) {
    fail('deleteRecord as rei', String(err))
  }

  const gotDelete = await waitFor(
    () =>
      commitOps(sakuraStream).some(
        (op) => op.action === 'delete' && op.path === path,
      ),
    10_000,
  )
  assert(
    gotDelete,
    'shared-boundary viewer receives the delete #commit',
    `path=${path}`,
  )
  const deleteOp = commitOps(sakuraStream).find(
    (op) => op.action === 'delete' && op.path === path,
  )
  assert(
    deleteOp !== undefined && deleteOp.record === undefined,
    'delete op carries no record body',
  )

  section('Boundary filtering excludes the other viewer')
  // Sakura already received both events on the same stream position, so a
  // short grace window is enough to prove kaoruko was filtered, not slow.
  await new Promise((r) => setTimeout(r, 1_000))
  const kaorukoOps = commitOps(kaorukoStream).filter((op) => op.path === path)
  assert(
    kaorukoOps.length === 0,
    'viewer without the boundary receives no frame for the record',
    `frames=${kaorukoStream.frames.length}`,
  )

  section('Unauthenticated connection is rejected')
  const anon = openStream(null, rei.did)
  await waitFor(() => anon.closed || anon.frames.length > 0, 5_000)
  // Auth failures surface as an ErrorFrame (op=-1) and/or a handshake close.
  assert(
    anon.closed || anon.frames.some((f) => f.header.op === -1),
    'no-auth connection is closed or receives an error frame',
    `closed=${anon.closed} frames=${anon.frames.length}`,
  )
  assert(
    anon.frames.every((f) => f.header.t !== '#commit'),
    'no-auth connection never receives a #commit',
  )

  info('closing streams')
  sakuraStream.close()
  kaorukoStream.close()
  anon.close()

  finish()
}

run().catch((err) => {
  console.error('\nSync stream test failed:', err)
  Deno.exit(1)
})
