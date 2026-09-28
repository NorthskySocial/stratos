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

function assertAtprotoUri(uri, authorityDid, roomId) {
  assert.ok(uri.startsWith('at://'), 'PDS returned a non-AT URI')
  const segments = uri.slice('at://'.length).split('/')
  assert.equal(segments.length, 7, 'Space record URI must have seven segments')
  assert.equal(
    segments[0],
    authorityDid,
    'Post is not in the configured Stratos space',
  )
  assert.equal(segments[1], 'space')
  assert.equal(segments[2], spaceType)
  assert.equal(segments[3], roomId)
  assert.equal(segments[5], postCollection)
  assert.ok(
    segments[4].startsWith('did:'),
    'Space URI is missing its repo author DID',
  )
  assert.ok(segments[6], 'Space URI is missing its record key')
}

async function trustSandboxCa() {
  const certPath = process.env.SANDBOX_CA_CERT?.trim() || '/ca/root.crt'
  await readFile(certPath)
  const database = path.join(
    process.env.XDG_CONFIG_HOME || '/tmp/config',
    'chromium-nssdb',
  )
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
    await candidate.click({ noWaitAfter: true, timeout: 2_000 }).catch(() => {})
    return true
  }
  return false
}

async function completeOAuth(page, account, origin) {
  const deadline = Date.now() + 60_000
  let leftClubhouse = false
  while (Date.now() < deadline) {
    const current = new URL(page.url())
    if (current.origin !== origin) leftClubhouse = true
    if (leftClubhouse && current.origin === origin) return

    const password = page
      .locator('input[name="password"], input[type="password"]')
      .first()
    if (await visible(password)) {
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
      if (await clickEnabled(submit)) {
        await delay(300)
        continue
      }
      await page.keyboard.press('Enter')
      await delay(300)
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

async function enterRoom(page, account, clubhouseUrl, roomId) {
  const card = roomCard(page, roomId)
  await card.waitFor({ state: 'visible', timeout: 30_000 })
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
    if (new URL(response.url()).pathname !== feedPath) return
    void response
      .json()
      .then((body) => responses.push({ status: response.status(), body }))
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
      assert.ok(
        delivered,
        'Clubhouse rendered the post without a successful Rust Feedgen response containing it',
      )
      return
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

async function provisionAccount(domain) {
  const pdsUrl = `https://spaces-pds-e2e.${domain}`
  const username = `motoko.spaces-pds-e2e.${domain}`
  const password = (
    await readFile('/run/sandbox-secrets/browser-password', 'utf8')
  ).trim()
  const adminPassword = (
    await readFile('/run/sandbox-secrets/pds-admin-password', 'utf8')
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
  if (session.ok) return { username, password }
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
  await requestJson(
    `${pdsUrl}/xrpc/com.atproto.server.createAccount`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `motoko@spaces-pds-e2e.${domain}`,
        handle: username,
        password,
        inviteCode: invitation.code,
      }),
    },
    'PDS account creation',
  )
  return { username, password }
}

async function ordinaryAccount(domain) {
  const state = JSON.parse(
    await readFile('/sandbox-state/accounts.json', 'utf8'),
  )
  const username = `user1.pds1.${domain}`
  const account = state.accounts?.[username]
  assert.ok(
    account?.password && account?.did,
    'Ordinary PDS account was not seeded',
  )
  return { username, password: account.password, did: account.did }
}

async function unjoinedOrdinaryAccount(domain) {
  const state = JSON.parse(
    await readFile('/sandbox-state/accounts.json', 'utf8'),
  )
  const username = `user2.pds1.${domain}`
  const account = state.accounts?.[username]
  assert.ok(
    account?.password && account?.did,
    'Unjoined PDS account was not seeded',
  )
  return { username, password: account.password, did: account.did }
}

async function assertSpaceLexicon(domain, authorityDid) {
  const query = new URL(
    `https://stratos-e2e.${domain}/xrpc/com.atproto.repo.getRecord`,
  )
  query.searchParams.set('repo', authorityDid)
  query.searchParams.set('collection', 'com.atproto.lexicon.schema')
  query.searchParams.set('rkey', 'zone.stratos.space.feed')
  const response = await fetch(query)
  assert.equal(response.status, 200, 'Space lexicon record did not resolve')
  const record = await response.json()
  assert.equal(record.value?.defs?.main?.type, 'space')
}

async function assertSpaceBlob(domain, account, authorityDid, roomId) {
  const pdsUrl = `https://spaces-pds-e2e.${domain}`
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
    'Space PDS session',
  )
  assert.ok(
    session.accessJwt && session.did,
    'Space PDS session was incomplete',
  )
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
  const space = `at://${authorityDid}/space/${spaceType}/${roomId}`
  await requestJson(
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
        validate: false,
        record: {
          $type: postCollection,
          text: `Blob fixture ${randomUUID()}`,
          createdAt: new Date().toISOString(),
          attachment: blob,
        },
      }),
    },
    'Space blob record',
  )
  const publicUrl = new URL(`${pdsUrl}/xrpc/com.atproto.sync.getBlob`)
  publicUrl.searchParams.set('did', session.did)
  publicUrl.searchParams.set('cid', cid)
  const publicResponse = await fetch(publicUrl)
  assert.equal(
    publicResponse.status,
    400,
    'Public sync.getBlob exposed a private-only blob',
  )
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

async function assertStratosCustody(domain, clubhouseUrl, roomId, pdsText) {
  const account = await ordinaryAccount(domain)
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const responses = listenForFeedResponses(page)
    await signIn(page, account, clubhouseUrl)
    await enterRoom(page, account, clubhouseUrl, roomId)
    const text = `Stratos custody sandbox E2E ${randomUUID()}`
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === stratosCreatePath &&
        response.ok(),
      { timeout: 45_000 },
    )
    await page.locator('#room-post').fill(text)
    await page.getByRole('button', { name: 'Post topic' }).click()
    const response = await responsePromise
    const result = await response.json()
    assert.ok(
      typeof result.uri === 'string' &&
        result.uri.startsWith(`at://${account.did}/`),
      'Ordinary PDS account did not use Stratos custody',
    )
    await waitForFeed(page, responses, text, result.uri)
    assert.ok(
      await visible(page.locator('.post', { hasText: pdsText }).first()),
      'The authorized feed did not include the PDS custody post',
    )
  } finally {
    await browser.close()
  }
}

async function assertNonmemberDenied(domain, clubhouseUrl, roomId, postText) {
  const account = await unjoinedOrdinaryAccount(domain)
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const responses = listenForFeedResponses(page)
    await signIn(page, account, clubhouseUrl)
    const card = roomCard(page, roomId)
    await card.waitFor({ state: 'visible', timeout: 30_000 })
    assert.ok(
      await visible(card.getByRole('button', { name: 'Join room' })),
      'Unjoined account was treated as a room member',
    )
    await page.goto(`${clubhouseUrl}/rooms/${encodeURIComponent(roomId)}`, {
      waitUntil: 'domcontentloaded',
    })
    await delay(2_000)
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
  } finally {
    await browser.close()
  }
}

async function main() {
  const domain = required('SANDBOX_DOMAIN')
  const account = await provisionAccount(domain)
  const clubhouseUrl = httpsUrl(
    `https://clubhouse-e2e.${domain}`,
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
    assertAtprotoUri(result.uri, authorityDid, roomId)
    const write = assertPdsCustodyWrite(writes, text)
    assert.equal(
      write.repo,
      result.uri.slice('at://'.length).split('/')[4],
      'PDS custody URI author does not match the createRecord repo',
    )
    await waitForFeed(page, feedResponses, text, result.uri)
    await assertSpaceLexicon(domain, authorityDid)
    await assertSpaceBlob(domain, account, authorityDid, roomId)
    await assertStratosCustody(domain, clubhouseUrl, roomId, text)
    await assertNonmemberDenied(domain, clubhouseUrl, roomId, text)
    console.log(
      JSON.stringify({
        suite: 'baseline',
        assertions: [
          'browser-oauth',
          'stratos-custody',
          'pds-custody',
          'space-lexicon',
          'publication-feed',
          'boundary-isolation',
          'public-private-blob-denied',
          'authenticated-space-blob',
        ].map((id) => ({ id, status: 'passed' })),
      }),
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(
    'Feedgen NG browser E2E failed:',
    error instanceof Error ? error.message : String(error),
  )
  process.exitCode = 1
})
