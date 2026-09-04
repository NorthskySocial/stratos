#!/usr/bin/env -S deno run -A
// DPoP CRUD test — record create/read/delete through the production auth path.
//
// Acquires a genuine DPoP-bound OAuth access token from the PDS with a
// loopback client, then calls Stratos with `Authorization: DPoP <token>`.
// The devMode bypass only catches the `Bearer` scheme, so these requests
// exercise the real DPoP verifier: proof check, jkt binding, enrollment.

import { type Browser, chromium } from 'npm:playwright@1.58.2'
import {
  atprotoLoopbackClientMetadata,
  buildAtprotoLoopbackClientId,
  NodeOAuthClient,
  type NodeSavedSession,
  type NodeSavedState,
  type OAuthSession,
  requestLocalLock,
} from 'npm:@atproto/oauth-client-node@0.5.3'
import { DOMAINS, PDS_URL, STRATOS_URL } from './lib/config.ts'
import { loadState } from './lib/state.ts'
import {
  fillSignInForm,
  screenshot,
  submitSignInAndConsent,
} from './lib/oauth-flow.ts'
import { assert, fail, finish, info, pass, section } from './lib/log.ts'

const CALLBACK_PORT = 8917
const CALLBACK_PATH = '/oauth/callback'
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`

// Mirrors buildCollectionScope(STRATOS_SCOPES.post, ['create', 'delete'])
// from stratos-client/src/scopes.ts (not importable from Deno).
const SCOPE = 'atproto repo:zone.stratos.feed.post?action=create&action=delete'
const COLLECTION = 'zone.stratos.feed.post'

function mapStore<V>() {
  const map = new Map<string, V>()
  return {
    get: (key: string) => map.get(key),
    set: (key: string, value: V) => {
      map.set(key, value)
    },
    del: (key: string) => {
      map.delete(key)
    },
  }
}

const sessionStore = mapStore<NodeSavedSession>()

function buildOAuthClient(): NodeOAuthClient {
  const clientId = buildAtprotoLoopbackClientId({
    scope: SCOPE,
    redirect_uris: [REDIRECT_URI],
  })
  return new NodeOAuthClient({
    clientMetadata: atprotoLoopbackClientMetadata(clientId),
    handleResolver: PDS_URL,
    stateStore: mapStore<NodeSavedState>(),
    sessionStore,
    requestLock: requestLocalLock,
    // The default safe fetch blocks loopback addresses; the local Stratos
    // and the callback listener both live on 127.0.0.1.
    fetch: globalThis.fetch,
  })
}

function startCallbackServer() {
  let resolveParams!: (params: URLSearchParams) => void
  const params = new Promise<URLSearchParams>((resolve) => {
    resolveParams = resolve
  })
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: CALLBACK_PORT, onListen() {} },
    (req) => {
      const url = new URL(req.url)
      if (url.pathname === CALLBACK_PATH) {
        resolveParams(url.searchParams)
        return new Response('Authorization received. You can close this tab.')
      }
      return new Response('Not found', { status: 404 })
    },
  )
  return { params, shutdown: () => server.shutdown() }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${what}`)),
      ms,
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function completeAuthorization(
  browser: Browser,
  authorizeUrl: string,
  handle: string,
  password: string,
) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  try {
    await page.goto(authorizeUrl, { waitUntil: 'load', timeout: 30_000 })
    await fillSignInForm(page, handle, password, 'dpop')
    await submitSignInAndConsent(page, 'dpop', (url) =>
      url.startsWith(REDIRECT_URI),
    )
  } catch (err) {
    await screenshot(page, 'dpop-error')
    throw err
  } finally {
    await context.close()
  }
}

async function acquireDpopSession(
  client: NodeOAuthClient,
  handle: string,
  password: string,
): Promise<OAuthSession> {
  const callbackServer = startCallbackServer()
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  try {
    const authorizeUrl = await client.authorize(handle, {
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
    })
    await completeAuthorization(browser, authorizeUrl.href, handle, password)
    const params = await withTimeout(
      callbackServer.params,
      30_000,
      'the authorization callback',
    )
    const { session } = await client.callback(params)
    return session
  } finally {
    await browser.close()
    await callbackServer.shutdown()
  }
}

/**
 * Stratos answers a missing nonce with a non-standard error body, so the
 * client library does not auto-retry. The nonce from the 401 response is
 * stored per-origin, so one manual retry succeeds.
 */
async function dpopFetch(
  session: OAuthSession,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const first = await session.fetchHandler(url, init)
  if (first.status !== 401 || !first.headers.get('dpop-nonce')) {
    return first
  }
  await first.body?.cancel()
  return session.fetchHandler(url, init)
}

async function testCrud(session: OAuthSession, base: string, did: string) {
  section('DPoP record CRUD')

  const record = {
    $type: COLLECTION,
    text: `Forged in Totosai's workshop at ${Date.now()}`,
    boundary: { values: [{ value: DOMAINS.swordsmith }] },
    createdAt: new Date().toISOString(),
  }

  const createRes = await dpopFetch(
    session,
    `${base}/xrpc/com.atproto.repo.createRecord`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: did, collection: COLLECTION, record }),
    },
  )
  if (createRes.status !== 200) {
    const body = await createRes.text()
    fail(
      'createRecord with DPoP auth',
      `status=${createRes.status} body=${body.slice(0, 200)}`,
    )
    return
  }
  const created = await createRes.json()
  pass('createRecord with DPoP auth', created.uri)

  const rkey = String(created.uri).split('/').pop() ?? ''
  const getUrl =
    `${base}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}` +
    `&collection=${COLLECTION}&rkey=${rkey}`

  const getRes = await dpopFetch(session, getUrl, { method: 'GET' })
  if (getRes.status !== 200) {
    await getRes.body?.cancel()
    fail('getRecord returns the created record', `status=${getRes.status}`)
  } else {
    const got = await getRes.json()
    assert(
      got.value?.text === record.text,
      'getRecord returns the created record',
      `text=${JSON.stringify(got.value?.text)}`,
    )
  }

  const delRes = await dpopFetch(
    session,
    `${base}/xrpc/com.atproto.repo.deleteRecord`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: did, collection: COLLECTION, rkey }),
    },
  )
  await delRes.body?.cancel()
  assert(
    delRes.status === 200,
    'deleteRecord with DPoP auth',
    `status=${delRes.status}`,
  )

  const goneRes = await dpopFetch(session, getUrl, { method: 'GET' })
  await goneRes.body?.cancel()
  assert(
    goneRes.status !== 200,
    'getRecord after delete does not return the record',
    `status=${goneRes.status}`,
  )
}

async function testRejections(base: string, did: string, accessToken: string) {
  section('DPoP proof rejection')

  const url = `${base}/xrpc/com.atproto.repo.createRecord`
  const body = JSON.stringify({
    repo: did,
    collection: COLLECTION,
    record: {
      $type: COLLECTION,
      text: 'should never land',
      boundary: { values: [{ value: DOMAINS.swordsmith }] },
      createdAt: new Date().toISOString(),
    },
  })

  const noProof = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `DPoP ${accessToken}`,
    },
    body,
  })
  await noProof.body?.cancel()
  assert(
    noProof.status === 401,
    'DPoP token without a proof header returns 401',
    `status=${noProof.status}`,
  )

  const tampered = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `DPoP ${accessToken}`,
      DPoP: 'ff.tampered.proof',
    },
    body,
  })
  await tampered.body?.cancel()
  assert(
    tampered.status === 401,
    'DPoP token with a tampered proof returns 401',
    `status=${tampered.status}`,
  )
}

async function run() {
  section('Phase 4b: DPoP CRUD (production auth)')

  const state = await loadState()
  const rei = state.users.rei
  if (!rei?.enrolled) {
    fail('User rei is not enrolled — run test-enrollment.ts first')
    finish()
  }

  // The verifier compares the proof htu against STRATOS_PUBLIC_URL, so the
  // request origin must match what setup.ts gave the service — the tunnel
  // URL, or the 127.0.0.1 (not localhost) fallback.
  const base = STRATOS_URL
  info(`Stratos base URL for DPoP requests: ${base}`)

  info(`Acquiring a DPoP-bound token for ${rei.handle} via OAuth...`)
  const client = buildOAuthClient()
  const session = await acquireDpopSession(client, rei.handle, rei.password)
  assert(
    session.did === rei.did,
    'OAuth session DID matches the enrolled user',
    session.did,
  )

  await testCrud(session, base, rei.did)

  const accessToken = sessionStore.get(session.did)?.tokenSet.access_token
  if (accessToken) {
    await testRejections(base, rei.did, accessToken)
  } else {
    fail('No access token found in the session store')
  }

  finish()
}

run().catch((err) => {
  console.error('\nDPoP CRUD test failed:', err)
  Deno.exit(1)
})
