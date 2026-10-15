import assert from 'node:assert/strict'
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  ECDH,
} from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const domain = process.env.SANDBOX_DOMAIN
const clubhouse = 'https://clubhouse-e2e.atmosbox.internal'
const authority = 'https://stratos-e2e.atmosbox.internal'
const pds = `https://october-pds-e2e.${domain}`
const authorityDid = `did:web:stratos-e2e.${domain}`
const space = `at://${authorityDid}/space/zone.stratos.space.feed/general`
const mintUrl = `${authority}/xrpc/zone.stratos.space.getSpaceCredential`
const postCollection = 'zone.stratos.feed.post'
async function visible(locator) {
  return locator.isVisible().catch(() => false)
}

async function trustSandboxCa() {
  const certificate = '/ca/root.crt'
  await readFile(certificate)
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
  } catch {}
  execFileSync(
    'certutil',
    [
      '-A',
      '-d',
      `sql:${database}`,
      '-n',
      'sandbox-ca',
      '-t',
      'C,,',
      '-i',
      certificate,
    ],
    { stdio: 'ignore' },
  )
}

async function clickEnabled(locator) {
  for (let index = 0; index < (await locator.count()); index += 1) {
    const button = locator.nth(index)
    if (
      (await button.isVisible().catch(() => false)) &&
      (await button.isEnabled())
    ) {
      await button.click({ noWaitAfter: true, timeout: 2_000 }).catch(() => {})
      return true
    }
  }
  return false
}

async function completeOAuth(page, username, password) {
  const deadline = Date.now() + 60_000
  let leftClubhouse = false
  while (Date.now() < deadline) {
    const current = new URL(page.url())
    if (current.origin !== clubhouse) leftClubhouse = true
    if (leftClubhouse && current.origin === clubhouse) return
    const passwordInput = page
      .locator('input[name="password"], input[type="password"]')
      .first()
    if (await passwordInput.isVisible().catch(() => false)) {
      const usernameInput = page
        .locator(
          'input[name="username"]:not([readonly]):not([disabled]), input[name="identifier"]:not([readonly]):not([disabled])',
        )
        .first()
      if (await usernameInput.isVisible().catch(() => false))
        await usernameInput.fill(username)
      await passwordInput.fill(password)
      if (
        await clickEnabled(
          page.locator('button[type="submit"], button:has-text("Sign in")'),
        )
      ) {
        await delay(300)
        continue
      }
      await page.keyboard.press('Enter')
      await delay(300)
      continue
    }
    if (
      await clickEnabled(
        page.locator(
          'button:has-text("Accept"), button:has-text("Authorize"), button:has-text("Allow")',
        ),
      )
    ) {
      await delay(300)
      continue
    }
    await delay(250)
  }
  throw new Error('OAuth callback did not complete')
}

async function loadAuth(page) {
  await page.evaluate((value) => {
    window.delegationScenarioDomain = value
  }, domain)
  await page.addScriptTag({ path: '/scenario/auth-client.iife.js' })
}

async function signIn(page, account, clubhouseUrl) {
  await page.goto(clubhouseUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('#handle').fill(account.username)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await completeOAuth(page, account.username, account.password)
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
  await completeOAuth(page, account.username, account.password)
  await waitForComposer(page)
}

async function requestJson(url, options, context) {
  const response = await fetch(url, options)
  if (!response.ok) {
    throw new Error(`${context} failed with HTTP ${response.status}`)
  }
  return await response.json()
}

async function provisionAccount(domain, name) {
  const pdsUrl = `https://october-pds-e2e.${domain}`
  const username = `${name}.october-pds-e2e.${domain}`
  const password = (
    await readFile('/run/sandbox-secrets/browser-password', 'utf8')
  ).trim()
  const adminPassword = (
    await readFile('/run/sandbox-secrets/october-admin-password', 'utf8')
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
    return { username, password, ...(await session.json()) }
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
        email: `${name}@october-pds-e2e.${domain}`,
        handle: username,
        password,
        inviteCode: invitation.code,
      }),
    },
    'PDS account creation',
  )
  return { username, password, ...created }
}

export async function acquireDelegation(page) {
  return page.evaluate(
    async ({ pdsUrl, spaceUri }) => {
      const session = window.delegationScenarioAuth.getSession()
      if (!session) throw new Error('OAuth session is unavailable')
      const url = new URL('/xrpc/com.atproto.space.getDelegationToken', pdsUrl)
      url.searchParams.set('space', spaceUri)
      const response = await session.fetchHandler(url.href, { method: 'GET' })
      if (!response.ok)
        throw new Error(`PDS delegation request failed: ${response.status}`)
      const body = await response.json()
      if (typeof body.token !== 'string')
        throw new Error('PDS returned no delegation')
      return body.token
    },
    { pdsUrl: pds, spaceUri: space },
  )
}

export function proofKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  })
  const jwk = publicKey.export({ format: 'jwk' })
  return { privateKey, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } }
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function proof(key, url, method, token) {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk }
  const claims = {
    htm: method,
    htu: new URL(url).origin + new URL(url).pathname,
    jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    ...(token
      ? { ath: createHash('sha256').update(token).digest('base64url') }
      : {}),
  }
  const signingInput = `${base64url(header)}.${base64url(claims)}`
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: key.privateKey,
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${signature.toString('base64url')}`
}

function keyId(key) {
  const raw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(key.jwk.x, 'base64url'),
    Buffer.from(key.jwk.y, 'base64url'),
  ])
  const bytes = Buffer.concat([
    Buffer.from([0x80, 0x24]),
    ECDH.convertKey(raw, 'prime256v1', undefined, undefined, 'compressed'),
  ])
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let number = BigInt('0x' + bytes.toString('hex'))
  let result = ''
  while (number > 0n) {
    result = alphabet[Number(number % 58n)] + result
    number /= 58n
  }
  return 'did:key:z' + result
}
export function signedHeaders(authorization, key, audience) {
  const fields = audience
    ? ['authorization', 'atproto-space-audience']
    : ['authorization']
  const params =
    '(' +
    fields.map((field) => '"' + field + '"').join(' ') +
    ');keyid="' +
    keyId(key) +
    '"'
  const headers = {
    authorization,
    ...(audience ? { 'atproto-space-audience': audience } : {}),
  }
  const canonical =
    fields.map((field) => '"' + field + '": ' + headers[field]).join('\n') +
    '\n"@signature-params": ' +
    params
  const signature = sign('sha256', Buffer.from(canonical), {
    key: key.privateKey,
    dsaEncoding: 'ieee-p1363',
  })
  return {
    ...headers,
    'signature-input': 'atproto-space=' + params,
    signature: 'atproto-space=:' + signature.toString('base64') + ':',
  }
}
async function standardExchange(token, key, extra = {}) {
  return fetch(mintUrl, {
    method: 'POST',
    headers: {
      ...signedHeaders('Bearer ' + token, key),
      'content-type': 'application/json',
      ...extra,
    },
    body: JSON.stringify({ space }),
  })
}
async function mint(token, key) {
  const response = await standardExchange(token, key)
  assert.equal(response.status, 200, 'Standard exchange failed')
  const body = await response.json()
  assert.equal(typeof body.credential, 'string')
  return body.credential
}
function recordsUrl(repo, selectedSpace = space) {
  const url = new URL('/xrpc/com.atproto.space.listRecords', pds)
  url.searchParams.set('repo', repo)
  url.searchParams.set('space', selectedSpace)
  url.searchParams.set('collection', postCollection)
  return url
}
export async function denied(response) {
  assert.ok([401, 403].includes(response.status), 'Request was not denied')
}

async function deniedCrossSpace(response) {
  if (response.status !== 400) return denied(response)
  const body = await response.json()
  assert.equal(body.error, 'InvalidCredential')
  assert.equal(body.message, 'Credential is not scoped to this space')
}

export async function credentialLifetime(
  response,
  expectedLifetime = 600,
  now = Math.floor(Date.now() / 1000),
) {
  assert.equal(response.status, 200, 'Credential exchange failed')
  const { credential } = await response.json()
  assert.equal(typeof credential, 'string')
  const parts = credential.split('.')
  assert.equal(parts.length, 3)
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url'))
  assert.ok(Number.isFinite(claims.iat))
  assert.ok(Number.isFinite(claims.exp))
  assert.ok(claims.iat <= now + 5)
  assert.ok(claims.exp > now)
  const lifetime = claims.exp - claims.iat
  assert.ok(lifetime > 0 && lifetime <= 3600)
  assert.equal(lifetime, expectedLifetime)
  return { credential, claims }
}

export async function deniedRenewal(exchange, removeMember) {
  const before = await exchange()
  await credentialLifetime(before)
  assert.equal(await removeMember(), 200, 'Member removal failed')
  await denied(await exchange())
}
export async function openBrowser() {
  assert.match(domain ?? '', /^[a-z0-9.-]+$/)
  const require = createRequire('/runner/feedgen-ng-e2e-browser.mjs')
  const { chromium } = require('playwright')
  await trustSandboxCa()
  return chromium.launch({ headless: true })
}

export async function prepareAccount(browser, name) {
  const account = await provisionAccount(domain, name)
  const context = await browser.newContext()
  const page = await context.newPage()
  await signIn(page, account, clubhouse)
  await enterRoom(page, account, clubhouse, 'general')
  const seedText = `Plan014 ${account.did} ${randomUUID()}`
  const seedWrite = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname ===
        '/xrpc/com.atproto.space.createRecord' &&
      response.ok(),
    { timeout: 45_000 },
  )
  await page.locator('#room-post').fill(seedText)
  await page.getByRole('button', { name: 'Post topic' }).click()
  const seedResponse = await seedWrite
  const seedRequest = seedResponse.request().postDataJSON()
  const seed = await seedResponse.json()
  assert.equal(seedRequest.repo, account.did)
  assert.equal(seedRequest.space, space)
  assert.equal(seedRequest.record.text, seedText)
  assert.equal(typeof seed.uri, 'string')
  assert.equal(typeof seed.cid, 'string')
  account.seedText = seedText
  await page.goto(clubhouse, { waitUntil: 'domcontentloaded' })
  await loadAuth(page)
  await page.evaluate(async () => {
    await window.delegationScenarioAuth.init()
  })
  return { account, page }
}

export async function removeMember(page) {
  return page.evaluate(async (authorityUrl) => {
    const session = window.delegationScenarioAuth.getSession()
    if (!session) throw new Error('OAuth session unavailable for removal')
    const response = await session.fetchHandler(
      new URL('/oauth/revoke', authorityUrl).href,
      { method: 'POST' },
    )
    return response.status
  }, authority)
}

export async function runScenario({
  open = openBrowser,
  prepare = prepareAccount,
  delegation = acquireDelegation,
  remove = removeMember,
} = {}) {
  const passed = []
  const browser = await open()
  try {
    const accounts = []
    for (const name of ['faye', 'edward']) {
      accounts.push(await prepare(browser, name))
    }
    const [{ account, page }, second] = accounts
    assert.notEqual(account.did, second.account.did)
    const key = proofKey()
    const initialDelegation = await delegation(page)
    const exchange = await standardExchange(initialDelegation, key)
    assert.equal(exchange.status, 200)
    const { credential, claims } = await credentialLifetime(exchange)
    assert.equal(claims.iss, authorityDid)
    assert.equal(claims.sub, space)
    assert.equal(claims.cnf.kid, keyId(key))
    assert.equal(claims.aud, undefined)
    assert.ok(claims.jti)
    passed.push('standard-exchange')
    assert.equal(claims.exp - claims.iat, 600)
    passed.push('default-lifetime-600')
    const headers = signedHeaders(
      'Atproto-Space ' + credential,
      key,
      account.did,
    )
    const first = await fetch(recordsUrl(account.did), { headers })
    assert.equal(first.status, 200, 'October PDS rejected Stratos credential')
    const firstRecords = (await first.json()).records
    assert.ok(
      firstRecords.some((item) => item.value?.text === account.seedText),
      'October read omitted seeded record',
    )
    passed.push('october-pds-read')
    assert.equal(
      (await fetch(recordsUrl(account.did), { headers })).status,
      200,
    )
    passed.push('same-signature-reused')
    await denied(await fetch(recordsUrl(second.account.did), { headers }))
    passed.push('wrong-owner-denied')
    const secondRead = await fetch(recordsUrl(second.account.did), {
      headers: signedHeaders(
        'Atproto-Space ' + credential,
        key,
        second.account.did,
      ),
    })
    assert.equal(secondRead.status, 200)
    assert.ok(
      (await secondRead.json()).records.some(
        (item) => item.value?.text === second.account.seedText,
      ),
      'Second owner read omitted seeded record',
    )
    passed.push('two-owners-one-host')
    await denied(
      await fetch(recordsUrl(account.did), {
        headers: signedHeaders(
          'Atproto-Space ' + credential,
          proofKey(),
          account.did,
        ),
      }),
    )
    passed.push('wrong-key-denied')
    const parts = credential.split('.')
    const changed = { ...claims, exp: claims.exp + 1 }
    parts[1] = Buffer.from(JSON.stringify(changed)).toString('base64url')
    await denied(
      await fetch(recordsUrl(account.did), {
        headers: signedHeaders(
          'Atproto-Space ' + parts.join('.'),
          key,
          account.did,
        ),
      }),
    )
    passed.push('tampered-token-denied')
    await deniedCrossSpace(
      await fetch(
        recordsUrl(account.did, space.replace('/general', '/other')),
        { headers },
      ),
    )
    passed.push('cross-space-denied')
    const authorityUrl = new URL(
      '/xrpc/zone.stratos.space.listRepos',
      authority,
    )
    authorityUrl.searchParams.set('space', space)
    assert.equal(
      (
        await fetch(authorityUrl, {
          headers: signedHeaders(
            'Atproto-Space ' + credential,
            key,
            authorityDid,
          ),
        })
      ).status,
      200,
    )
    passed.push('stratos-read')
    const nextKey = proofKey()
    const renewed = await mint(await delegation(page), nextKey)
    const renewedClaims = JSON.parse(
      Buffer.from(renewed.split('.')[1], 'base64url'),
    )
    assert.equal(renewedClaims.cnf.kid, keyId(nextKey))
    assert.notEqual(renewedClaims.cnf.kid, claims.cnf.kid)
    assert.equal(
      (
        await fetch(recordsUrl(account.did), {
          headers: signedHeaders(
            'Atproto-Space ' + renewed,
            nextKey,
            account.did,
          ),
        })
      ).status,
      200,
    )
    passed.push('renewal-fresh-key')
    await denied(await standardExchange(initialDelegation, proofKey()))
    passed.push('delegation-replay-denied')
    const fresh = await delegation(page)
    await denied(
      await standardExchange(fresh, key, { dpop: proof(key, mintUrl, 'POST') }),
    )
    passed.push('conflicting-proof-denied')
    const legacyResponse = await fetch(mintUrl, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + fresh,
        dpop: proof(key, mintUrl, 'POST'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ space }),
    })
    assert.equal(legacyResponse.status, 200)
    const legacy = (await legacyResponse.json()).credential
    assert.equal(
      typeof JSON.parse(Buffer.from(legacy.split('.')[1], 'base64url')).cnf.jkt,
      'string',
    )
    assert.equal(
      (
        await fetch(authorityUrl, {
          headers: {
            authorization: 'DPoP ' + legacy,
            dpop: proof(key, authorityUrl.href, 'GET', legacy),
          },
        })
      ).status,
      200,
    )
    passed.push('legacy-compatible')
    await deniedRenewal(
      async () => standardExchange(await delegation(page), proofKey()),
      () => remove(page),
    )
    passed.push('renewal-after-removal-denied')
    return {
      suite: 'standard-credential-transport',
      assertions: passed.map((id) => ({ id, status: 'passed' })),
    }
  } finally {
    await browser.close()
  }
}
export async function main(argv = process.argv, run = runScenario) {
  if (!argv[1] || path.resolve(argv[1]) !== new URL(import.meta.url).pathname)
    return
  try {
    console.log(JSON.stringify(await run()))
  } catch (error) {
    console.error(
      'Standard credential scenario failed: ' +
        (error instanceof Error ? error.name : 'UnknownError'),
    )
    process.exitCode = 1
  }
}
await main()
