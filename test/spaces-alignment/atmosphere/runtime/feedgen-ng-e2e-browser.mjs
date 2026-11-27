#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'

const require = createRequire('/runner/feedgen-ng-e2e-browser.mjs')
const { chromium } = require('playwright')
const pdsCreatePath = '/xrpc/com.atproto.space.createRecord'
const stratosCreatePath = '/oauth/boundaries/post'
const feedPath = '/xrpc/zone.stratos.feedgen.getFeed'
const postCollection = 'zone.stratos.feed.post'
const spaceType = 'zone.stratos.space.feed'

function required(name) {
  const value = process.env[name]?.trim()
  assert.ok(value, `Missing required environment variable ${name}`)
  return value
}

function httpsUrl(value, name) {
  const parsed = new URL(value)
  assert.equal(parsed.protocol, 'https:', `${name} must use HTTPS`)
  assert.equal(parsed.username, '', `${name} must not contain URL credentials`)
  assert.equal(parsed.password, '', `${name} must not contain URL credentials`)
  return parsed.toString().replace(/\/$/, '')
}

function spaceUriFromParts(authorityDid, skey) {
  return `at:space/${authorityDid}/${spaceType}/${skey}`
}

function assertSpaceRecordUri(uri, space) {
  assert.ok(
    uri.startsWith(`${space}/`),
    'Post is not in the configured Stratos space',
  )
  const [author, collection, rkey, ...extra] = uri
    .slice(space.length + 1)
    .split('/')
  assert.ok(
    author?.startsWith('did:'),
    'Space URI is missing its repo author DID',
  )
  assert.equal(collection, postCollection)
  assert.ok(rkey, 'Space URI is missing its record key')
  assert.equal(extra.length, 0, 'Space record URI has extra parts')
  return { author, rkey }
}

function assertCustodyUri(uri, did) {
  const prefix = `at://${did}/${postCollection}/`
  assert.ok(
    typeof uri === 'string' && uri.startsWith(prefix),
    'Ordinary PDS account did not use Stratos custody',
  )
  const rkey = uri.slice(prefix.length)
  assert.ok(rkey && !rkey.includes('/'), 'Custody URI is missing its rkey')
}

let activeSuite = 'baseline'

// The runner reads these lines to name the assertions reached when a run fails.
function reach(assertionId) {
  console.log(
    JSON.stringify({
      progress: 'assertion-reached',
      suite: activeSuite,
      id: assertionId,
    }),
  )
}

async function trustSandboxCa() {
  const certPath = process.env.SANDBOX_CA_CERT?.trim() || '/ca/root.crt'
  await readFile(certPath)
  const database = path.join(process.env.HOME || '/tmp/config', '.pki', 'nssdb')
  await mkdir(database, { recursive: true })
  try {
    execFileSync(
      'certutil',
      ['-N', '-d', `sql:${database}`, '--empty-password'],
      {
        stdio: 'ignore',
      },
    )
  } catch {
    // An existing profile database is expected when the runner is reused.
  }
  execFileSync(
    'certutil',
    [
      '-A',
      '-d',
      `sql:${database}`,
      '-n',
      'atmosphere-in-a-box-e2e',
      '-t',
      'C,,',
      '-i',
      certPath,
    ],
    { stdio: 'ignore' },
  )
}

async function visible(locator) {
  return locator.isVisible().catch(() => false)
}

async function clickEnabled(locator) {
  for (let index = 0; index < (await locator.count()); index += 1) {
    const candidate = locator.nth(index)
    if (!(await visible(candidate)) || !(await candidate.isEnabled())) continue
    try {
      await candidate.click({ noWaitAfter: true, timeout: 2_000 })
      return true
    } catch {
      continue
    }
  }
  return false
}

async function completeOAuth(page, account, origin) {
  const deadline = Date.now() + 60_000
  let leftClubhouse = false
  let credentialsSubmitted = false
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return
    if (new URL(frame.url()).origin !== origin) leftClubhouse = true
  })
  while (Date.now() < deadline) {
    const current = new URL(page.url())
    if (current.origin !== origin) leftClubhouse = true
    if (leftClubhouse && current.origin === origin) return

    const password = page
      .locator('input[name="password"], input[type="password"]')
      .first()
    if (!credentialsSubmitted && (await visible(password))) {
      const username = page
        .locator(
          'input[name="username"]:not([readonly]):not([disabled]), input[name="identifier"]:not([readonly]):not([disabled])',
        )
        .first()
      if (await visible(username)) await username.fill(account.username)
      await password.fill(account.password)
      const submit = page.locator(
        'button[type="submit"], button:has-text("Sign in")',
      )
      if (!(await clickEnabled(submit))) await page.keyboard.press('Enter')
      credentialsSubmitted = true
      continue
    }

    const consent = page.locator(
      'button:has-text("Accept"), button:has-text("Authorize"), button:has-text("Allow")',
    )
    if (await clickEnabled(consent)) {
      await delay(300)
      continue
    }
    await delay(250)
  }
  throw new Error('Timed out completing the alpha PDS OAuth flow')
}

async function signIn(page, account, clubhouseUrl) {
  const origin = new URL(clubhouseUrl).origin
  await page.goto(clubhouseUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('#handle').fill(account.username)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await completeOAuth(page, account, origin)
  await page.locator('.signed-in-account').waitFor({
    state: 'visible',
    timeout: 30_000,
  })
  const note = await page.locator('.header-note').textContent()
  assert.ok(
    note?.includes(account.username),
    'Clubhouse did not hydrate the signed-in handle',
  )
  assert.ok(
    await visible(page.getByRole('button', { name: 'Sign out' })),
    'Clubhouse sign-in did not complete',
  )
}

function roomCard(page, roomId) {
  return page.locator('.room-card', {
    has: page.locator(
      `a.room-link[href="/rooms/${encodeURIComponent(roomId)}"]`,
    ),
  })
}

async function waitForComposer(page) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const composer = page.locator('#room-post')
    if (await visible(composer)) return
    const recheck = page.getByRole('button', { name: 'Check room again' })
    if (await visible(recheck)) {
      await recheck.click()
      await composer
        .waitFor({ state: 'visible', timeout: 5_000 })
        .catch(() => {})
      if (await visible(composer)) return
    }
    await page.reload({ waitUntil: 'domcontentloaded' })
    await composer.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
  }
  throw new Error('Room did not become ready after enrollment reconciliation')
}

async function waitForRoomAction(scope) {
  try {
    await scope
      .getByRole('button', { name: /^(Open room|Join room)$/ })
      .waitFor({ state: 'visible', timeout: 30_000 })
  } catch {
    const state = {}
    for (const name of [
      'Checking access…',
      'Open room',
      'Join room',
      'Request pending…',
      'Joining unavailable',
    ]) {
      state[name] = await visible(
        scope.getByRole('button', { name, exact: true }),
      )
    }
    throw new Error(`Room action did not resolve: ${JSON.stringify(state)}`)
  }
}

async function enterRoom(page, account, clubhouseUrl, roomId) {
  const card = roomCard(page, roomId)
  await card.waitFor({ state: 'visible', timeout: 30_000 })
  await waitForRoomAction(card)
  const open = card.getByRole('button', { name: 'Open room' })
  if (await visible(open)) {
    await open.click()
    await waitForComposer(page)
    return
  }
  const join = card.getByRole('button', { name: 'Join room' })
  assert.ok(await visible(join), `Room ${roomId} has no open or join action`)
  await join.click()
  await completeOAuth(page, account, new URL(clubhouseUrl).origin)
  await waitForComposer(page)
}

function listenForPdsWrites(page) {
  const writes = []
  page.on('request', (request) => {
    if (
      request.method() !== 'POST' ||
      new URL(request.url()).pathname !== pdsCreatePath
    )
      return
    try {
      const body = request.postData()
      if (body) writes.push(JSON.parse(body))
    } catch {
      // The expected write assertion fails if the body is absent or invalid.
    }
  })
  return writes
}

function listenForFeedResponses(page) {
  const responses = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.pathname !== feedPath) return
    const feed = url.searchParams.get('feed')
    const cursor = url.searchParams.get('cursor')
    void response
      .json()
      .then((body) =>
        responses.push({ status: response.status(), body, feed, cursor }),
      )
      .catch(() => {})
  })
  return responses
}

function recordFromWrite(writes, text) {
  return writes
    .map((write) => write.record)
    .find(
      (record) => record && typeof record === 'object' && record.text === text,
    )
}

function assertPdsCustodyWrite(writes, text) {
  const record = recordFromWrite(writes, text)
  assert.ok(record, 'No PDS space write was observed for the unique test post')
  assert.equal(record.$type, postCollection)
  assert.equal(record.text, text)
  assert.equal(
    Object.hasOwn(record, 'boundary'),
    false,
    'PDS custody writes must not supply a boundary',
  )
  assert.equal(
    Object.hasOwn(record, 'reply'),
    false,
    'The test topic must not contain a reply reference',
  )
  const write = writes.find((candidate) => candidate.record === record)
  return write
}

async function waitForFeed(page, responses, text, uri) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const post = page.locator('.post', { hasText: text }).first()
    if (await visible(post)) {
      const delivered = responses.some(
        ({ status, body }) =>
          status === 200 &&
          Array.isArray(body?.feed) &&
          body.feed.some(
            (item) =>
              item?.post?.uri === uri && item?.post?.record?.text === text,
          ),
      )
      if (delivered) return
    }
    await page.reload({ waitUntil: 'domcontentloaded' })
    await post.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {})
    await delay(1_000)
  }
  throw new Error(
    'Rust Feedgen did not return the PDS custody post to Clubhouse',
  )
}

async function requestJson(url, options, context) {
  const response = await fetch(url, options)
  if (!response.ok) {
    throw new Error(`${context} failed with HTTP ${response.status}`)
  }
  return await response.json()
}

async function provisionAccount(
  domain,
  name = process.env.FEEDGEN_E2E_PDS_ACCOUNT || 'motoko',
) {
  const pdsUrl = `https://pds-space1.${domain}`
  assert.match(name, /^(motoko|batou)$/)
  const username = `${name}.pds-space1.${domain}`
  const password = (
    await readFile('/run/sandbox-secrets/browser-password', 'utf8')
  ).trim()
  const adminPassword = (
    await readFile('/sandbox-state/pds-admin-password', 'utf8')
  ).trim()
  const sessionBody = { identifier: username, password }
  const session = await fetch(
    `${pdsUrl}/xrpc/com.atproto.server.createSession`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sessionBody),
    },
  )
  if (session.ok) {
    pdsSessions.set(username, await session.json())
    return { username, password }
  }
  if (session.status !== 400 && session.status !== 401) {
    throw new Error(`PDS account lookup failed with HTTP ${session.status}`)
  }
  const basic = Buffer.from(`admin:${adminPassword}`).toString('base64')
  const invitation = await requestJson(
    `${pdsUrl}/xrpc/com.atproto.server.createInviteCode`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ useCount: 1 }),
    },
    'PDS invite creation',
  )
  assert.equal(
    typeof invitation.code,
    'string',
    'PDS invite response has no code',
  )
  const created = await requestJson(
    `${pdsUrl}/xrpc/com.atproto.server.createAccount`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `${name}@pds-space1.${domain}`,
        handle: username,
        password,
        inviteCode: invitation.code,
      }),
    },
    'PDS account creation',
  )
  pdsSessions.set(username, created)
  return { username, password }
}

async function seededBrowserAccount(username) {
  const state = JSON.parse(
    await readFile('/sandbox-state/accounts.json', 'utf8'),
  )
  const account = state.accounts?.[username]
  assert.ok(account?.password && account?.did, 'Browser account was not seeded')
  return { username, password: account.password, did: account.did }
}

async function ordinaryAccount(domain) {
  return await seededBrowserAccount(`user1.pds1.${domain}`)
}

async function unjoinedOrdinaryAccount(domain) {
  return await seededBrowserAccount(`user2.pds1.${domain}`)
}

const pdsSessions = new Map()

function accountPdsUrl(domain, account) {
  const host = account.username.includes(`.pds1.${domain}`)
    ? `pds1.${domain}`
    : `pds-space1.${domain}`
  return `https://${host}`
}

async function pdsSession(domain, account) {
  const cached = pdsSessions.get(account.username)
  if (cached) {
    assert.ok(
      cached.accessJwt && cached.did,
      'Space PDS session was incomplete',
    )
    return cached
  }
  const pdsUrl = accountPdsUrl(domain, account)
  const session = await requestJson(
    `${pdsUrl}/xrpc/com.atproto.server.createSession`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: account.username,
        password: account.password,
      }),
    },
    `${account.username} PDS session`,
  )
  assert.ok(
    session.accessJwt && session.did,
    'Space PDS session was incomplete',
  )
  pdsSessions.set(account.username, session)
  return session
}

async function pdsEnrollment(domain, account, authorityDid) {
  const session = await pdsSession(domain, account)
  const query = new URL(
    `${accountPdsUrl(domain, account)}/xrpc/com.atproto.repo.getRecord`,
  )
  query.searchParams.set('repo', session.did)
  query.searchParams.set('collection', 'zone.stratos.actor.enrollment')
  query.searchParams.set('rkey', authorityDid)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await fetch(query)
    if (response.ok) return (await response.json()).value
    assert.ok(
      response.status === 400 || response.status === 404,
      `PDS enrollment lookup failed with HTTP ${response.status}`,
    )
    await delay(500)
  }
  throw new Error('PDS enrollment record was not published')
}

async function assertSpaceLexiconPublished(domain) {
  const query = new URL(
    `https://authority.${domain}/xrpc/com.atproto.repo.getRecord`,
  )
  query.searchParams.set('repo', `schemas.authority.${domain}`)
  query.searchParams.set('collection', 'com.atproto.lexicon.schema')
  query.searchParams.set('rkey', 'zone.stratos.space.feed')
  const response = await fetch(query)
  assert.equal(response.status, 200, 'Space lexicon record did not resolve')
  const record = await response.json()
  assert.equal(record.value?.defs?.main?.type, 'space')
}

// The alpha PDS resolves the space NSID during Stratos OAuth. PDS custody in
// the PDS-hosted enrollment record proves that the scope was granted there.
async function assertPdsGrantedSpaceScope(domain, authorityDid, account) {
  const enrollment = await pdsEnrollment(domain, account, authorityDid)
  assert.equal(enrollment.custody, 'pds', 'PDS did not grant the space scope')
  assert.equal(
    new URL(enrollment.repoHost).origin,
    `https://pds-space1.${domain}`,
    'PDS grant did not select the space repo host',
  )
}

async function writeSpaceBlobFixture(domain, account, authorityDid, roomId) {
  const pdsUrl = `https://pds-space1.${domain}`
  const session = await pdsSession(domain, account)
  const payload = Buffer.from(`Private space blob ${randomUUID()}`)
  const upload = await requestJson(
    `${pdsUrl}/xrpc/com.atproto.repo.uploadBlob`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.accessJwt}`,
        'content-type': 'text/plain',
      },
      body: payload,
    },
    'Space blob upload',
  )
  const blob = upload.blob
  const cid = blob?.ref?.$link
  assert.ok(
    typeof cid === 'string' && cid.length > 0,
    'Space blob upload returned no CID',
  )
  const space = spaceUriFromParts(authorityDid, roomId)
  const write = await requestJson(
    `${pdsUrl}${pdsCreatePath}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.accessJwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        space,
        repo: session.did,
        collection: postCollection,
        record: {
          $type: postCollection,
          text: `Blob fixture ${randomUUID()}`,
          createdAt: new Date().toISOString(),
          embed: {
            $type: 'app.bsky.embed.images',
            images: [{ alt: 'Private sandbox fixture', image: blob }],
          },
        },
      }),
    },
    'Space blob record',
  )
  assert.ok(
    write.uri?.startsWith(`${space}/${session.did}/${postCollection}/`),
    'PDS did not accept the space-scoped record write',
  )
  assert.equal(
    write.validationStatus,
    'unknown',
    'PDS did not run its default record validation path',
  )
  return { pdsUrl, session, cid, payload, space }
}

async function assertPublicBlobDenied({ pdsUrl, session, cid }) {
  const publicUrl = new URL(`${pdsUrl}/xrpc/com.atproto.sync.getBlob`)
  publicUrl.searchParams.set('did', session.did)
  publicUrl.searchParams.set('cid', cid)
  const publicResponse = await fetch(publicUrl)
  assert.equal(
    publicResponse.status,
    400,
    'Public sync.getBlob exposed a private-only blob',
  )
}

async function assertAuthenticatedSpaceBlob({
  pdsUrl,
  session,
  cid,
  payload,
  space,
}) {
  const privateUrl = new URL(`${pdsUrl}/xrpc/com.atproto.space.getBlob`)
  privateUrl.searchParams.set('space', space)
  privateUrl.searchParams.set('repo', session.did)
  privateUrl.searchParams.set('cid', cid)
  const privateResponse = await fetch(privateUrl, {
    headers: { authorization: `Bearer ${session.accessJwt}` },
  })
  assert.equal(
    privateResponse.status,
    200,
    'Authenticated space blob fetch failed',
  )
  assert.deepEqual(Buffer.from(await privateResponse.arrayBuffer()), payload)
}

async function postAsCustodyMember(page, account, text) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === stratosCreatePath &&
      response.ok(),
    { timeout: 45_000 },
  )
  await page.locator('#room-post').fill(text)
  await page.getByRole('button', { name: 'Post topic' }).click()
  const result = await (await responsePromise).json()
  assertCustodyUri(result.uri, account.did)
  return result
}

async function assertStratosCustody(domain, clubhouseUrl, roomId, pdsText) {
  const account = await ordinaryAccount(domain)
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const responses = listenForFeedResponses(page)
    await signIn(page, account, clubhouseUrl)
    await enterRoom(page, account, clubhouseUrl, roomId)
    const text = `Stratos custody sandbox E2E ${randomUUID()}`
    const result = await postAsCustodyMember(page, account, text)
    await waitForFeed(page, responses, text, result.uri)
    assert.ok(
      await visible(page.locator('.post', { hasText: pdsText }).first()),
      'The authorized feed did not include the PDS custody post',
    )
    reach('stratos-custody')
  } finally {
    await browser.close()
  }
}

async function enrollThroughStratos(page, account) {
  const authorization = new URL(
    'https://stratos-e2e.atmosbox.internal/oauth/authorize',
  )
  authorization.searchParams.set('handle', account.username)
  await page.goto(authorization.toString(), {
    waitUntil: 'domcontentloaded',
  })
  await completeOAuth(page, account, authorization.origin)
  const result = JSON.parse(await page.locator('body').innerText())
  assert.equal(result.success, true, 'Unrelated actor enrollment failed')
  assert.equal(result.did, account.did)
}

async function assertEnrolledOnlyInOtherBoundary(
  domain,
  account,
  authorityDid,
) {
  const enrollment = await pdsEnrollment(domain, account, authorityDid)
  const boundaries = enrollment.boundaries?.map((item) => item.value)
  assert.ok(Array.isArray(boundaries), 'Unrelated enrollment has no boundaries')
  assert.ok(
    boundaries.includes(`${authorityDid}/other`),
    'Unrelated actor did not receive its distinct boundary',
  )
  assert.ok(
    !boundaries.includes(`${authorityDid}/general`),
    'Unrelated actor unexpectedly received the target boundary',
  )
}

async function assertFeedEmptyOrRefused(domain, account, roomId) {
  const session = await pdsSession(domain, account)
  const feedUrl = new URL(
    `${accountPdsUrl(domain, account)}/xrpc/zone.stratos.feedgen.getFeed`,
  )
  feedUrl.searchParams.set('feed', roomId)
  feedUrl.searchParams.set('limit', '50')
  const deadline = Date.now() + 30_000
  let feedResponse
  while (Date.now() < deadline) {
    feedResponse = await fetch(feedUrl, {
      headers: {
        authorization: `Bearer ${session.accessJwt}`,
        'atproto-proxy': `did:web:feedgen-e2e.${domain}#stratos_feedgen`,
      },
    })
    if (feedResponse.ok) break
    const body = await feedResponse.clone().json()
    if (body.error !== 'FeedNotReady') break
    await delay(500)
  }
  assert.ok(feedResponse, 'Unrelated-boundary feed was never requested')
  if (feedResponse.ok) {
    const body = await feedResponse.json()
    assert.ok(
      Array.isArray(body.feed) && body.feed.length === 0,
      'Unrelated-boundary actor received target feed content',
    )
  } else {
    const body = await feedResponse.json()
    assert.equal(body.error, 'BoundaryMismatch')
  }
}

async function assertNonmemberDenied(domain, clubhouseUrl, roomId, postText) {
  const account = await unjoinedOrdinaryAccount(domain)
  const authorityDid = `did:web:stratos-e2e.${domain}`
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const responses = listenForFeedResponses(page)
    await enrollThroughStratos(page, account)
    await assertEnrolledOnlyInOtherBoundary(domain, account, authorityDid)
    await assertFeedEmptyOrRefused(domain, account, roomId)
    reach('unrelated-boundary-denied')

    await signIn(page, account, clubhouseUrl)
    const card = roomCard(page, roomId)
    await card.waitFor({ state: 'visible', timeout: 30_000 })
    await waitForRoomAction(card)
    assert.ok(
      await visible(card.getByRole('button', { name: 'Join room' })),
      'Unjoined account was treated as a room member',
    )
    await page.goto(`${clubhouseUrl}/rooms/${encodeURIComponent(roomId)}`, {
      waitUntil: 'domcontentloaded',
    })
    await page
      .locator('.room-view .placeholder-panel, .room-view #room-post')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .catch(() => {
        throw new Error('Room route access did not resolve')
      })
    assert.ok(
      await visible(
        page.locator('.room-view').getByRole('button', { name: 'Join room' }),
      ),
      'Unjoined account was treated as a room member on the room route',
    )
    assert.equal(
      await visible(page.locator('.post', { hasText: postText }).first()),
      false,
      'Unjoined account saw a private room post',
    )
    assert.equal(
      await visible(page.locator('#room-post')),
      false,
      'Unjoined account received a private room composer',
    )
    assert.ok(
      responses.every(
        ({ status, body }) =>
          status !== 200 ||
          !Array.isArray(body?.feed) ||
          body.feed.every((item) => item?.post?.record?.text !== postText),
      ),
      'Feedgen returned private content to an account without the boundary',
    )
    reach('boundary-isolation')
  } finally {
    await browser.close()
  }
}

async function deletePostFromClubhouse(page, text) {
  const post = page.locator('.post', { hasText: text }).first()
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      new URL(response.url()).pathname === stratosCreatePath,
    { timeout: 45_000 },
  )
  await post.getByRole('button', { name: 'Delete', exact: true }).click()
  await post.getByRole('button', { name: 'Delete now' }).click()
  assert.equal(
    (await responsePromise).status(),
    200,
    'Stratos custody post deletion failed',
  )
}

async function waitForFeedWithout(page, responses, text, uri) {
  const listed = (item) =>
    item?.post?.uri === uri || item?.post?.record?.text === text
  const lists = ({ status, body }) =>
    status === 200 && Array.isArray(body?.feed) && body.feed.some(listed)
  // An empty answer for another feed or a later page says nothing about the
  // feed that served the post, so only a fresh first page of it counts.
  const heldBy = new Set(responses.filter(lists).map(({ feed }) => feed))
  if (heldBy.size === 0) {
    throw new Error('No feed response held the custody post before deletion')
  }
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const before = responses.length
    await page.reload({ waitUntil: 'domcontentloaded' })
    await delay(1_000)
    const fresh = responses.slice(before).filter(({ status }) => status === 200)
    const firstPageOfHolder = fresh.some(
      ({ feed, cursor }) => heldBy.has(feed) && cursor === null,
    )
    if (
      firstPageOfHolder &&
      fresh.every(
        ({ body }) => Array.isArray(body?.feed) && !body.feed.some(listed),
      )
    ) {
      return
    }
  }
  throw new Error('Rust Feedgen still returned the deleted custody post')
}

const ordinaryCustodyAssertions = [
  'ordinary-sign-in',
  'ordinary-custody-post',
  'ordinary-feed-delivery',
  'ordinary-nonmember-denied',
  'ordinary-delete',
]

// The Stratos-custody journey on the ordinary PDS. Sign-in reaches the
// Clubhouse through its handle resolver, and the spaces PDS holds no account,
// scope or record of this journey.
async function runOrdinaryCustody() {
  const domain = required('SANDBOX_DOMAIN')
  const clubhouseUrl = httpsUrl(
    'https://clubhouse-e2e.atmosbox.internal',
    'Clubhouse URL',
  )
  const roomId = process.env.FEEDGEN_E2E_ROOM?.trim() || 'general'
  assert.match(roomId, /^[a-z0-9-]+$/, 'FEEDGEN_E2E_ROOM must be a room slug')
  const authorityDid = `did:web:stratos-e2e.${domain}`
  await trustSandboxCa()

  const account = await ordinaryAccount(domain)
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const responses = listenForFeedResponses(page)
    await signIn(page, account, clubhouseUrl)
    await enterRoom(page, account, clubhouseUrl, roomId)
    const enrollment = await pdsEnrollment(domain, account, authorityDid)
    assert.notEqual(
      enrollment.custody,
      'pds',
      'Ordinary PDS account was enrolled as PDS custody',
    )
    reach('ordinary-sign-in')

    const text = `Ordinary custody sandbox E2E ${randomUUID()}`
    const result = await postAsCustodyMember(page, account, text)
    reach('ordinary-custody-post')

    await waitForFeed(page, responses, text, result.uri)
    reach('ordinary-feed-delivery')

    const other = await unjoinedOrdinaryAccount(domain)
    const otherPage = await browser.newPage()
    await enrollThroughStratos(otherPage, other)
    await assertEnrolledOnlyInOtherBoundary(domain, other, authorityDid)
    await assertFeedEmptyOrRefused(domain, other, roomId)
    reach('ordinary-nonmember-denied')

    await deletePostFromClubhouse(page, text)
    await waitForFeedWithout(page, responses, text, result.uri)
    reach('ordinary-delete')

    console.log(
      JSON.stringify({
        suite: 'ordinary-custody',
        coverage:
          'Ordinary custody only: one Stratos-custody member on the ordinary PDS. PDS custody, space credentials and the spaces PDS are not covered.',
        assertions: ordinaryCustodyAssertions.map((id) => ({
          id,
          status: 'passed',
        })),
      }),
    )
  } finally {
    await browser.close()
  }
}

const novemberPositiveAssertions = [
  'schema-grant',
  'oauth-create',
  'oauth-read',
  'authorized-feed',
  'credential-read',
  'oauth-delete',
]

async function runNovemberPositive() {
  const domain = required('SANDBOX_DOMAIN')
  const account = await provisionAccount(domain)
  const clubhouseUrl = 'https://clubhouse-e2e.atmosbox.internal'
  const roomId = process.env.FEEDGEN_E2E_ROOM?.trim() || 'general'
  assert.match(roomId, /^[a-z0-9-]+$/)
  const space = spaceUriFromParts(`did:web:stratos-e2e.${domain}`, roomId)
  await trustSandboxCa()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const writes = listenForPdsWrites(page)
    const responses = listenForFeedResponses(page)
    await signIn(page, account, clubhouseUrl)
    await enterRoom(page, account, clubhouseUrl, roomId)
    await assertSpaceLexiconPublished(domain)
    await assertPdsGrantedSpaceScope(
      domain,
      `did:web:stratos-e2e.${domain}`,
      account,
    )
    reach('schema-grant')
    const text = `November positive journey ${randomUUID()}`
    const create = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === pdsCreatePath &&
        response.ok(),
      { timeout: 45_000 },
    )
    await page.locator('#room-post').fill(text)
    await page.getByRole('button', { name: 'Post topic' }).click()
    const result = await (await create).json()
    const { author, rkey } = assertSpaceRecordUri(result.uri, space)
    assert.equal(assertPdsCustodyWrite(writes, text).repo, author)
    assert.ok(result.cid)
    reach('oauth-create')

    await page.evaluate((value) => {
      window.delegationScenarioDomain = value
    }, domain)
    await page.addScriptTag({ path: '/scenario/auth-client.iife.js' })
    const record = await page.evaluate(
      async ({ space, author, rkey, collection }) => {
        await window.delegationScenarioAuth.init()
        const session = window.delegationScenarioAuth.getSession()
        if (!session || session.sub !== author)
          throw new Error('OAuth author session unavailable')
        const query = new URLSearchParams({
          space,
          repo: author,
          collection,
          rkey,
        })
        const response = await session.fetchHandler(
          `/xrpc/com.atproto.space.getRecord?${query}`,
        )
        if (!response.ok)
          throw new Error(`OAuth record read failed: ${response.status}`)
        return response.json()
      },
      { space, author, rkey, collection: postCollection },
    )
    assert.equal(record.uri, result.uri)
    assert.equal(record.cid, result.cid)
    assert.equal(record.value?.text, text)
    reach('oauth-read')

    await waitForFeed(page, responses, text, result.uri)
    reach('authorized-feed')
    await page.evaluate((value) => {
      window.delegationScenarioDomain = value
    }, domain)
    await page.addScriptTag({ path: '/scenario/auth-client.iife.js' })
    await page.evaluate(async () => {
      await window.delegationScenarioAuth.init()
    })

    const delegation = await page.evaluate(
      async ({ space, pdsUrl }) => {
        const session = window.delegationScenarioAuth.getSession()
        if (!session) throw new Error('OAuth session unavailable')
        const url = new URL(
          '/xrpc/com.atproto.space.getDelegationToken',
          pdsUrl,
        )
        url.searchParams.set('space', space)
        const response = await session.fetchHandler(url.href)
        if (!response.ok)
          throw new Error(`Delegation failed: ${response.status}`)
        return (await response.json()).token
      },
      { space, pdsUrl: accountPdsUrl(domain, account) },
    )
    assert.equal(typeof delegation, 'string')
    const delegationClaims = JSON.parse(
      Buffer.from(delegation.split('.')[1], 'base64url'),
    )
    assert.equal(delegationClaims.sub, space)
    assert.equal(
      delegationClaims.aud,
      `did:web:stratos-e2e.${domain}#atproto_pds`,
    )
    const { proofKey, exchangeHeaders, presentationHeaders } =
      await import('/scenario/driver.mjs')
    const key = proofKey()
    const exchange = await fetch(
      `https://stratos-e2e.atmosbox.internal/xrpc/zone.stratos.space.getSpaceCredential`,
      {
        method: 'POST',
        headers: {
          ...exchangeHeaders(`Bearer ${delegation}`, key),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ space }),
      },
    )
    assert.equal(exchange.status, 200, 'Stratos credential exchange failed')
    const { credential } = await exchange.json()
    assert.equal(typeof credential, 'string')
    const claims = JSON.parse(
      Buffer.from(credential.split('.')[1], 'base64url'),
    )
    assert.equal(claims.sub, space)
    assert.equal(claims.iss, `did:web:stratos-e2e.${domain}`)
    const expectedKey = /keyid="([^"]+)"/.exec(
      exchangeHeaders(`Bearer ${delegation}`, key)['signature-input'],
    )?.[1]
    assert.equal(claims.cnf?.kid, expectedKey)
    assert.ok(expectedKey)

    assert.ok(author.startsWith('did:plc:'), 'Sandbox author DID is not PLC')
    const didDocument = await requestJson(
      `https://plc.${domain}/${author}`,
      {},
      'Member DID document',
    )
    assert.equal(didDocument.id, author)
    const methods = didDocument.verificationMethod?.filter(
      (method) =>
        method.id === '#atproto_kem' || method.id === `${author}#atproto_kem`,
    )
    assert.equal(
      methods?.length,
      1,
      'Member DID document lacks a unique KEM key',
    )
    assert.equal(methods[0].type, 'Multikey')
    const kemKey = `did:key:${methods[0].publicKeyMultibase}`
    const sdk = await import('/scenario/sdk.mjs')
    const encapsulation = await sdk.encapsulate(kemKey)
    const signedUrl = new URL(
      `${accountPdsUrl(domain, account)}/xrpc/com.atproto.space.getRecord`,
    )
    for (const [name, value] of Object.entries({
      space,
      repo: author,
      collection: postCollection,
      rkey,
    }))
      signedUrl.searchParams.set(name, value)
    const signedRead = await fetch(signedUrl, {
      headers: {
        ...presentationHeaders(credential, key, author),
        'accept-signature': sdk.formatMacRequest(
          'atproto-space-record',
          encapsulation.keyShare,
        ),
      },
    })
    assert.equal(signedRead.status, 200, 'Credential-bound read failed')
    const signedRecord = await signedRead.json()
    assert.equal(signedRecord.uri, result.uri)
    assert.equal(signedRecord.cid, result.cid)
    assert.equal(signedRecord.value?.text, text)
    sdk.verifyRecordMac(result.uri, result.cid, {
      ...encapsulation,
      headers: signedRead.headers,
    })
    reach('credential-read')
    const post = page.locator('.post', { hasText: text }).first()
    const deletion = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          '/xrpc/com.atproto.space.deleteRecord',
      { timeout: 45_000 },
    )
    await post.getByRole('button', { name: 'Delete', exact: true }).click()
    await post.getByRole('button', { name: 'Delete now' }).click()
    const deleted = await deletion
    assert.ok(deleted.ok(), `PDS delete failed with HTTP ${deleted.status()}`)
    const request = deleted.request().postDataJSON()
    assert.deepEqual(request, {
      space,
      repo: author,
      collection: postCollection,
      rkey,
    })
    await waitForFeedWithout(page, responses, text, result.uri)
    reach('oauth-delete')
    console.log(
      JSON.stringify({
        suite: 'november-positive',
        assertions: novemberPositiveAssertions.map((id) => ({
          id,
          status: 'passed',
        })),
      }),
    )
  } finally {
    await browser.close()
  }
}

async function runNovemberUpstreamMint() {
  const domain = required('SANDBOX_DOMAIN')
  const origin = `https://pds-space1.${domain}`
  await requestJson(
    `${origin}/xrpc/_health`,
    { signal: AbortSignal.timeout(10_000) },
    'Published member PDS readiness',
  )
  reach('member-pds-ready')
  const account = await provisionAccount(domain, 'batou')
  const owner = await pdsSession(domain, account)
  const did = owner.did
  const ownerHeaders = { authorization: `Bearer ${owner.accessJwt}` }
  const postJson = (nsid, body, headers = {}) =>
    requestJson(
      `${origin}/xrpc/${nsid}`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      },
      nsid,
    )
  const skey = `bebop-${randomUUID()}`
  const { space } = await postJson(
    'com.atproto.space.createSpace',
    {
      skey,
      spaceType,
      policy: { $type: 'com.atproto.personalspace.policy' },
    },
    ownerHeaders,
  )
  assert.equal(space, spaceUriFromParts(did, skey))
  reach('personal-space-created')

  const rkey = randomUUID()
  const text = 'See you space cowboy'
  const { uri, cid } = await postJson(
    'com.atproto.space.createRecord',
    {
      space,
      repo: did,
      collection: postCollection,
      rkey,
      validate: false,
      record: {
        $type: postCollection,
        text,
        createdAt: new Date().toISOString(),
      },
    },
    ownerHeaders,
  )
  assert.equal(uri, `${space}/${did}/${postCollection}/${rkey}`)
  assert.match(cid, /^b[a-z2-7]+$/)
  reach('personal-record-written')

  const delegationUrl = new URL(
    '/xrpc/com.atproto.space.getDelegationToken',
    origin,
  )
  delegationUrl.searchParams.set('space', space)
  const { token } = await requestJson(
    delegationUrl,
    { headers: ownerHeaders, signal: AbortSignal.timeout(30_000) },
    'Upstream delegation issuance',
  )
  assert.ok(
    typeof token === 'string' && token.length > 0,
    'Missing upstream delegation',
  )
  const { proofKey, keyId, presentationHeaders } =
    await import('/scenario/driver.mjs')
  const key = proofKey()
  const credentialKey = keyId(key)
  const { credential } = await postJson(
    'com.atproto.space.authorizeSpaceSync',
    {
      space,
      credentialKey,
      delegationToken: token,
    },
  )
  assert.ok(
    typeof credential === 'string' && credential.split('.').length === 3,
    'Missing upstream credential',
  )
  const claims = JSON.parse(Buffer.from(credential.split('.')[1], 'base64url'))
  assert.ok(
    claims.iss === did &&
      claims.sub === space &&
      claims.cnf?.kid === credentialKey,
    'Upstream credential claims do not match the fixture',
  )
  reach('upstream-credential-issued')

  const document = await requestJson(
    `https://plc.${domain}/${did}`,
    { signal: AbortSignal.timeout(30_000) },
    'Upstream authority DID document',
  )
  assert.equal(document.id, did)
  assert.ok(
    document.service?.some(
      (service) =>
        (service.id === '#atproto_pds' ||
          service.id === `${did}#atproto_pds`) &&
        new URL(service.serviceEndpoint).origin === origin,
    ),
    'Upstream authority resolves to a different PDS',
  )
  const kem = document.verificationMethod?.find(
    (method) =>
      method.id === '#atproto_kem' || method.id === `${did}#atproto_kem`,
  )
  assert.ok(
    kem?.type === 'Multikey' && typeof kem.publicKeyMultibase === 'string',
    'Authority KEM key unavailable',
  )
  const { encapsulate, formatMacRequest, verifyRecordMac } =
    await import('/scenario/sdk.mjs')
  const proof = await encapsulate(`did:key:${kem.publicKeyMultibase}`)
  const readUrl = new URL('/xrpc/com.atproto.space.getRecord', origin)
  readUrl.search = new URLSearchParams({
    space,
    repo: did,
    collection: postCollection,
    rkey,
  })
  const read = await fetch(readUrl, {
    headers: {
      ...presentationHeaders(credential, key, did),
      'accept-signature': formatMacRequest(
        'atproto-space-record',
        proof.keyShare,
      ),
    },
    signal: AbortSignal.timeout(30_000),
  })
  assert.equal(read.status, 200, 'Upstream credential read did not complete')
  const result = await read.json()
  assert.ok(
    result.uri === uri && result.cid === cid && result.value?.text === text,
    'Upstream credential read did not return the seeded record',
  )
  verifyRecordMac(uri, cid, { ...proof, headers: read.headers })
  reach('upstream-credential-read-verified')
  const { verifyCommitMac } = await import('/scenario/sdk.mjs')
  async function readOps(since, cursor) {
    const url = new URL('/xrpc/com.atproto.space.listRepoOps', origin)
    url.search = new URLSearchParams({ space, repo: did, limit: '1' })
    if (since) url.searchParams.set('since', since)
    if (cursor) url.searchParams.set('cursor', cursor)
    const pageProof = await encapsulate(`did:key:${kem.publicKeyMultibase}`)
    const response = await fetch(url, {
      headers: {
        ...presentationHeaders(credential, key, did),
        'accept-signature': formatMacRequest(
          'atproto-space-commit',
          pageProof.keyShare,
        ),
      },
      signal: AbortSignal.timeout(30_000),
    })
    assert.equal(response.status, 200, 'Pinned host ops read failed')
    const body = await response.json()
    assert.ok(Array.isArray(body.ops), 'Pinned host ops response has no page')
    assert.ok(
      body.commit?.space === space &&
        body.commit?.repo === did &&
        typeof body.commit.rev === 'string',
      'Pinned host ops commit is for a different target',
    )
    const data = Buffer.from(body.commit.data.$bytes, 'base64')
    assert.equal(data.length, 32)
    verifyCommitMac(
      { ...body.commit, data },
      { ...pageProof, headers: response.headers },
    )
    return body
  }

  const base = (await readOps()).commit.rev
  const nextKey = randomUUID()
  const next = await postJson(
    'com.atproto.space.createRecord',
    {
      space,
      repo: did,
      collection: postCollection,
      rkey: nextKey,
      validate: false,
      record: {
        $type: postCollection,
        text: 'Bang',
        createdAt: new Date().toISOString(),
      },
    },
    ownerHeaders,
  )
  const fullPage = await readOps(base)
  assert.equal(fullPage.ops.length, 1)
  assert.ok(
    fullPage.ops[0].rkey === nextKey && fullPage.ops[0].cid === next.cid,
    'The incremental page omitted the fixture operation',
  )
  assert.notEqual(fullPage.commit.rev, base)
  assert.ok(
    typeof fullPage.cursor === 'string' && fullPage.cursor.length > 0,
    'Pinned host ended on the full page',
  )
  reach('incremental-full-page-with-continuation')
  const terminal = await readOps(base, fullPage.cursor)
  assert.equal(terminal.ops.length, 0)
  assert.equal(terminal.cursor, undefined)
  assert.equal(terminal.commit.rev, fullPage.commit.rev)
  reach('empty-terminal-page-verified')
  writeBrowserReceipt([
    'member-pds-ready',
    'personal-space-created',
    'personal-record-written',
    'upstream-credential-issued',
    'upstream-credential-read-verified',
    'incremental-full-page-with-continuation',
    'empty-terminal-page-verified',
  ])
}

const inspectorUrl = 'https://webapp-e2e.atmosbox.internal'
const inspectorReadPath = '/xrpc/com.atproto.space.getRecord'

async function seedInspectorPost(browser, domain, account) {
  const clubhouse = 'https://clubhouse-e2e.atmosbox.internal'
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const page = await context.newPage()
    await signIn(page, account, clubhouse)
    await enterRoom(page, account, clubhouse, 'general')
    const text = `Bebop inspector ${randomUUID()}`
    const origin = accountPdsUrl(domain, account)
    const write = page.waitForResponse(
      (response) => {
        const url = new URL(response.url())
        return (
          url.origin === origin &&
          url.pathname === pdsCreatePath &&
          response.request().method() === 'POST'
        )
      },
      { timeout: 45_000 },
    )
    await page.locator('#room-post').fill(text)
    await page.getByRole('button', { name: 'Post topic' }).click()
    const response = await write
    assert.equal(response.status(), 200, 'Inspector fixture write failed')
    const { uri, cid } = await response.json()
    const space = spaceUriFromParts(`did:web:stratos-e2e.${domain}`, 'general')
    const { author, rkey } = assertSpaceRecordUri(uri, space)
    assert.equal(author, (await pdsSession(domain, account)).did)
    assert.ok(
      typeof cid === 'string' && cid.length > 0,
      'Inspector fixture has no CID',
    )
    return {
      uri,
      cid,
      text,
      origin,
      address: { space, repo: author, collection: postCollection, rkey },
    }
  } finally {
    await context.close()
  }
}

async function signInToInspectorApp(page, account) {
  await page.goto(inspectorUrl, { waitUntil: 'domcontentloaded' })
  await page.getByLabel('Bluesky handle').fill(account.username)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await completeOAuth(page, account, inspectorUrl)
  await page
    .getByRole('button', { name: 'Log Out' })
    .waitFor({ timeout: 30_000 })
}

function inspectorCard(page, seed) {
  return page.getByRole('article').filter({ hasText: seed.text })
}

async function waitForInspectorFeed(page, seed, responses) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const containsSeed = responses.some(
      ({ status, body }) =>
        status === 200 &&
        Array.isArray(body?.feed) &&
        body.feed.some(
          ({ post }) =>
            post?.uri === seed.uri &&
            post?.cid === seed.cid &&
            post?.record?.text === seed.text,
        ),
    )
    if (containsSeed && (await visible(inspectorCard(page, seed)))) return
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 })
    await delay(1_000)
  }
  throw new Error(
    'Webapp did not render the exact fixture entry from a real feed response',
  )
}

function observeInspectorRequests(context, authorOrigin) {
  const pending = new Map()
  const recordReads = []
  let authorRequests = 0
  let sequence = 0
  let lastActivity = performance.now()
  context.on('request', (request) => {
    pending.set(request, ++sequence)
    lastActivity = performance.now()
    const url = new URL(request.url())
    if (url.origin === authorOrigin) authorRequests += 1
    if (url.pathname === inspectorReadPath) recordReads.push(request)
  })
  const finish = (request) => {
    if (pending.delete(request)) lastActivity = performance.now()
  }
  context.on('requestfinished', finish)
  context.on('requestfailed', finish)

  async function waitForIdle(after = sequence) {
    // Requests from before this interaction can stay open in the background.
    // They remain observable; only requests begun in the interaction can block idle.
    const started = performance.now()
    const quietPeriod = 500
    const deadline = started + 5_000
    while (performance.now() < deadline) {
      if (
        ![...pending.values()].some((started) => started > after) &&
        performance.now() - Math.max(started, lastActivity) >= quietPeriod
      )
        return
      await delay(25)
    }
    throw new Error('Inspector browser context did not reach request idle')
  }

  return {
    recordReads,
    markInteraction: () => sequence,
    waitForIdle,
    async assertNoAuthorRequests(after) {
      await waitForIdle(after)
      assert.equal(
        authorRequests,
        0,
        'The viewer browser contacted the author PDS',
      )
    },
  }
}

async function inspectorSettled(page) {
  const dialog = page.getByRole('dialog', { name: 'Record Inspector' })
  await dialog.waitFor({ timeout: 15_000 })
  await dialog
    .locator('[role="status"]')
    .waitFor({ state: 'hidden', timeout: 15_000 })
  return dialog
}

async function runNovemberOwnInspector() {
  const domain = required('SANDBOX_DOMAIN')
  await trustSandboxCa()
  const browser = await chromium.launch({ headless: true })
  try {
    // The webapp resolver reaches the alpha handle through the sandbox inventory.
    const account = await seededBrowserAccount(`user1.pds-space1.${domain}`)
    const seed = await seedInspectorPost(browser, domain, account)
    reach('inspector-owner-fixture-written')
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const observation = observeInspectorRequests(context, seed.origin)
    const page = await context.newPage()
    const responses = listenForFeedResponses(page)
    await signInToInspectorApp(page, account)
    await waitForInspectorFeed(page, seed, responses)
    reach('inspector-owner-feed-observed')
    await observation.waitForIdle()
    const priorReads = observation.recordReads.length
    const ownRead = observation.markInteraction()
    await inspectorCard(page, seed)
      .getByRole('button', { name: 'Inspect your record on your PDS' })
      .click()
    const dialog = await inspectorSettled(page)
    await dialog
      .getByText(seed.text, { exact: false })
      .waitFor({ timeout: 15_000 })
    assert.equal(
      await dialog.locator('.panel-label').textContent(),
      'Your record on your PDS',
    )
    assert.equal(await dialog.locator('.panel-address').textContent(), seed.uri)
    await observation.waitForIdle(ownRead)
    const reads = observation.recordReads.slice(priorReads)
    assert.equal(
      reads.length,
      1,
      'The inspector did not send exactly one record request',
    )
    const [request] = reads
    const url = new URL(request.url())
    assert.equal(url.origin, seed.origin)
    assert.equal(request.method(), 'GET')
    assert.deepEqual(Object.fromEntries(url.searchParams), seed.address)
    const scheme = (await request.headerValue('authorization'))?.split(
      ' ',
      1,
    )[0]
    assert.equal(
      scheme,
      'DPoP',
      'The inspector did not use an OAuth-bound read',
    )
    const response = await request.response()
    assert.equal(response?.status(), 200)
    const record = await response.json()
    assert.ok(
      record.uri === seed.uri &&
        record.cid === seed.cid &&
        record.value?.text === seed.text,
      'The PDS returned a different record or CID',
    )
    reach('own-record-read-verified')

    const invalid = 'Invalid inspector fixture'
    const invalidRead = observation.markInteraction()
    await page.route(
      `**${feedPath}?*`,
      async (route) => {
        const real = await route.fetch({ maxRedirects: 0 })
        assert.equal(
          real.status(),
          200,
          'The feed control could not fetch its seed',
        )
        const body = await real.json()
        const existing = body.feed.find(({ post }) => post.uri === seed.uri)
        assert.ok(existing, 'The feed control has no seeded entry')
        const entry = structuredClone(existing)
        entry.post.uri = 'at:space/invalid'
        entry.post.record.text = invalid
        await route.fulfill({
          response: real,
          json: { ...body, feed: [entry] },
        })
      },
      { times: 1 },
    )
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 })
    await page
      .getByRole('article')
      .filter({ hasText: invalid })
      .getByRole('button', { name: 'Inspect this record' })
      .click({ timeout: 15_000 })
    const invalidDialog = await inspectorSettled(page)
    assert.equal(
      await invalidDialog.getByRole('alert').textContent(),
      'This record address is not valid',
    )
    await observation.waitForIdle(invalidRead)
    assert.equal(
      observation.recordReads.length,
      priorReads + 1,
      'The invalid address caused a PDS read',
    )
    reach('invalid-address-sends-no-read')
    writeBrowserReceipt([
      'inspector-owner-fixture-written',
      'inspector-owner-feed-observed',
      'own-record-read-verified',
      'invalid-address-sends-no-read',
    ])
  } finally {
    await browser.close()
  }
}

async function runNovemberSnapshotInspector() {
  const domain = required('SANDBOX_DOMAIN')
  await trustSandboxCa()
  const browser = await chromium.launch({ headless: true })
  try {
    const author = await provisionAccount(domain, 'motoko')
    const seed = await seedInspectorPost(browser, domain, author)
    reach('snapshot-author-fixture-written')
    const viewer = await ordinaryAccount(domain)
    assert.notEqual(viewer.did, seed.address.repo)
    assert.notEqual(accountPdsUrl(domain, viewer), seed.origin)
    const clubhouse = 'https://clubhouse-e2e.atmosbox.internal'
    const join = await browser.newContext()
    try {
      const page = await join.newPage()
      await signIn(page, viewer, clubhouse)
      await enterRoom(page, viewer, clubhouse, 'general')
    } finally {
      await join.close()
    }

    const context = await browser.newContext({ serviceWorkers: 'block' })
    const observation = observeInspectorRequests(context, seed.origin)
    const page = await context.newPage()
    const responses = listenForFeedResponses(page)
    await signInToInspectorApp(page, viewer)
    await waitForInspectorFeed(page, seed, responses)
    reach('snapshot-viewer-feed-observed')
    const interaction = observation.markInteraction()
    await inspectorCard(page, seed)
      .getByRole('button', { name: 'Inspect the copy the feed served' })
      .click()
    const dialog = await inspectorSettled(page)
    assert.equal(
      await dialog.locator('.panel-label').textContent(),
      'Feed snapshot',
    )
    assert.equal(await dialog.locator('.panel-address').textContent(), seed.uri)
    await dialog
      .locator('.json-block')
      .getByText(seed.text, { exact: false })
      .waitFor({ timeout: 15_000 })
    await observation.assertNoAuthorRequests(interaction)
    reach('other-author-snapshot-verified')
    writeBrowserReceipt([
      'snapshot-author-fixture-written',
      'snapshot-viewer-feed-observed',
      'other-author-snapshot-verified',
    ])
  } finally {
    await browser.close()
  }
}

async function runNovemberMembershipControl() {
  const domain = required('SANDBOX_DOMAIN')
  const authority = `did:web:stratos-e2e.${domain}`
  const clubhouse = 'https://clubhouse-e2e.atmosbox.internal'
  const viewer = await unjoinedOrdinaryAccount(domain)
  await trustSandboxCa()
  const browser = await chromium.launch({ headless: true })
  try {
    const member = await provisionAccount(domain, 'motoko')
    const seed = await seedInspectorPost(browser, domain, member)
    const page = await browser.newPage()
    await enrollThroughStratos(page, viewer)
    await assertEnrolledOnlyInOtherBoundary(domain, viewer, authority)
    await assertFeedEmptyOrRefused(domain, viewer, 'general')
    reach('unjoined-viewer-ineligible')

    const responses = listenForFeedResponses(page)
    await signIn(page, viewer, clubhouse)
    await enterRoom(page, viewer, clubhouse, 'general')
    await waitForFeed(page, responses, seed.text, seed.uri)
    reach('joined-viewer-eligible')
    writeBrowserReceipt([
      'unjoined-viewer-ineligible',
      'joined-viewer-eligible',
    ])
  } finally {
    await browser.close()
  }
}

async function runNovemberReferenceReads() {
  required('SANDBOX_DOMAIN')
  const { runReferenceReadControls } = await import('/scenario/driver.mjs')
  await runReferenceReadControls(reach)
  writeBrowserReceipt([
    'reference-seed-written',
    'reference-credential-issued',
    'reference-mint-read-verified',
    'both-reference-owners-read',
  ])
}

function writeBrowserReceipt(ids) {
  console.log(
    JSON.stringify({
      suite: activeSuite,
      assertions: ids.map((id) => ({ id, status: 'passed' })),
    }),
  )
}

const baselineAssertions = [
  'browser-oauth',
  'stratos-custody',
  'pds-custody',
  'space-lexicon',
  'pds-space-grant',
  'publication-feed',
  'boundary-isolation',
  'unrelated-boundary-denied',
  'public-private-blob-denied',
  'authenticated-space-blob',
]

async function runBaseline() {
  const domain = required('SANDBOX_DOMAIN')
  const account = await provisionAccount(domain)
  const clubhouseUrl = httpsUrl(
    'https://clubhouse-e2e.atmosbox.internal',
    'Clubhouse URL',
  )
  const roomId = process.env.FEEDGEN_E2E_ROOM?.trim() || 'general'
  assert.match(roomId, /^[a-z0-9-]+$/, 'FEEDGEN_E2E_ROOM must be a room slug')
  const authorityDid = `did:web:stratos-e2e.${domain}`
  assert.match(authorityDid, /^did:(web|plc):/, 'Space authority must be a DID')
  await trustSandboxCa()

  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const writes = listenForPdsWrites(page)
    const feedResponses = listenForFeedResponses(page)
    await signIn(page, account, clubhouseUrl)
    await page.locator('.room-card').first().waitFor({
      state: 'visible',
      timeout: 30_000,
    })
    assert.ok(
      (await page.locator('.room-card').count()) > 0,
      'Authenticated room catalogue is empty',
    )
    const card = roomCard(page, roomId)
    await card.waitFor({ state: 'visible', timeout: 30_000 })
    await enterRoom(page, account, clubhouseUrl, roomId)
    reach('browser-oauth')

    const text = `Feedgen NG sandbox E2E ${randomUUID()}`
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === pdsCreatePath &&
        response.ok(),
      { timeout: 45_000 },
    )
    await page.locator('#room-post').fill(text)
    await page.getByRole('button', { name: 'Post topic' }).click()
    const response = await responsePromise
    const result = await response.json()
    assert.ok(
      typeof result.uri === 'string' && typeof result.cid === 'string',
      'Alpha PDS did not return a record strong reference',
    )
    const { author } = assertSpaceRecordUri(
      result.uri,
      spaceUriFromParts(authorityDid, roomId),
    )
    const write = assertPdsCustodyWrite(writes, text)
    assert.equal(
      write.repo,
      author,
      'PDS custody URI author does not match the createRecord repo',
    )
    reach('pds-custody')
    await waitForFeed(page, feedResponses, text, result.uri)
    reach('publication-feed')
    await assertSpaceLexiconPublished(domain)
    reach('space-lexicon')
    await assertPdsGrantedSpaceScope(domain, authorityDid, account)
    reach('pds-space-grant')
    const blobFixture = await writeSpaceBlobFixture(
      domain,
      account,
      authorityDid,
      roomId,
    )
    await assertPublicBlobDenied(blobFixture)
    reach('public-private-blob-denied')
    await assertAuthenticatedSpaceBlob(blobFixture)
    reach('authenticated-space-blob')
    await assertStratosCustody(domain, clubhouseUrl, roomId, text)
    await assertNonmemberDenied(domain, clubhouseUrl, roomId, text)
    console.log(
      JSON.stringify({
        suite: 'baseline',
        assertions: baselineAssertions.map((id) => ({ id, status: 'passed' })),
      }),
    )
  } finally {
    await browser.close()
  }
}

const journeys = {
  baseline: runBaseline,
  'ordinary-custody': runOrdinaryCustody,
  'november-positive': runNovemberPositive,
  'november-upstream-mint': runNovemberUpstreamMint,
  'november-own-inspector': runNovemberOwnInspector,
  'november-snapshot-inspector': runNovemberSnapshotInspector,
  'november-membership-control': runNovemberMembershipControl,
  'november-reference-reads': runNovemberReferenceReads,
}

async function main() {
  activeSuite = process.argv[2] ?? 'baseline'
  assert.ok(Object.hasOwn(journeys, activeSuite), 'Unknown suite')
  await journeys[activeSuite]()
}

main().catch((error) => {
  console.error(
    'Feedgen NG browser E2E failed:',
    error instanceof Error ? error.message : String(error),
  )
  process.exitCode = 1
})
