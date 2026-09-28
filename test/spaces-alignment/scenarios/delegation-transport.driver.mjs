import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire('/runner/feedgen-ng-e2e-browser.mjs')
const { chromium } = require('playwright')
const domain = process.env.SANDBOX_DOMAIN
assert.match(domain ?? '', /^[a-z0-9.-]+$/)
const clubhouse = 'https://clubhouse-e2e.atmosbox.internal'
const authority = 'https://stratos-e2e.atmosbox.internal'
const pds = `https://spaces-pds-e2e.${domain}`
const authorityDid = `did:web:stratos-e2e.${domain}`
const space = `at://${authorityDid}/space/zone.stratos.space.feed/general`
const mintUrl = `${authority}/xrpc/zone.stratos.space.getSpaceCredential`
const passed = []

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
  } catch {
    // The sandbox browser profile may already have a trust database.
  }
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

async function oauthSession(page) {
  const username = `motoko.spaces-pds-e2e.${domain}`
  const password = (
    await readFile('/run/sandbox-secrets/browser-password', 'utf8')
  ).trim()
  await page.route(`${clubhouse}/assets/**`, (route) => route.abort())
  await page.goto(clubhouse, { waitUntil: 'domcontentloaded' })
  await loadAuth(page)
  await page
    .evaluate(
      (handle) => window.delegationScenarioAuth.signIn(handle),
      username,
    )
    .catch(() => {})
  await completeOAuth(page, username, password)
  await loadAuth(page)
  const did = await page.evaluate(async () => {
    const session = await window.delegationScenarioAuth.init()
    if (!session) throw new Error('OAuth session was not restored')
    return session.sub
  })
  assert.ok(did.startsWith('did:'), 'OAuth session has no account DID')
  passed.push('oauth-space-session')
  return did
}

async function getDelegation(page) {
  return page.evaluate(
    async ({ pdsUrl, spaceUri }) => {
      const session = window.delegationScenarioAuth.getSession()
      if (!session) throw new Error('OAuth session is unavailable')
      const url = new URL('/xrpc/com.atproto.space.getDelegationToken', pdsUrl)
      url.searchParams.set('space', spaceUri)
      const response = await session.fetchHandler(
        new Request(url, { method: 'GET' }),
      )
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

function proofKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  })
  const jwk = publicKey.export({ format: 'jwk' })
  return { privateKey, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } }
}

function base64url(value) {
  return Buffer.from(
    typeof value === 'string' ? value : JSON.stringify(value),
  ).toString('base64url')
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

async function exchange(token, key, body = { space }) {
  const response = await fetch(mintUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      dpop: proof(key, mintUrl, 'POST'),
    },
    body: JSON.stringify(body),
  })
  return response
}

async function exchangeWithoutProof(token) {
  return fetch(mintUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ space }),
  })
}

async function main() {
  await trustSandboxCa()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const did = await oauthSession(page)
    const firstDelegation = await getDelegation(page)
    const payload = JSON.parse(
      Buffer.from(firstDelegation.split('.')[1], 'base64url'),
    )
    assert.equal(payload.iss, did)
    assert.equal(payload.sub, space)
    assert.equal(payload.aud, `${authorityDid}#atproto_space_host`)
    passed.push('pds-issued-delegation')

    const key = proofKey()
    const mint = await exchange(firstDelegation, key)
    assert.equal(mint.status, 200, 'Header delegation exchange failed')
    const credential = (await mint.json()).credential
    assert.equal(typeof credential, 'string')
    passed.push('header-exchange')

    const recordsUrl = new URL('/xrpc/com.atproto.space.listRecords', pds)
    recordsUrl.searchParams.set('space', space)
    recordsUrl.searchParams.set('repo', did)
    recordsUrl.searchParams.set('collection', 'zone.stratos.feed.post')
    const recordsResponse = await fetch(recordsUrl, {
      headers: {
        authorization: `DPoP ${credential}`,
        dpop: proof(key, recordsUrl.href, 'GET', credential),
      },
    })
    assert.equal(recordsResponse.status, 200, 'Foreign repo read failed')
    const records = (await recordsResponse.json()).records
    assert.ok(Array.isArray(records) && records.length > 0)
    passed.push('foreign-repo-read')

    const wrongKey = proofKey()
    const wrongKeyResponse = await fetch(recordsUrl, {
      headers: {
        authorization: `DPoP ${credential}`,
        dpop: proof(wrongKey, recordsUrl.href, 'GET', credential),
      },
    })
    assert.ok([401, 403].includes(wrongKeyResponse.status))
    passed.push('wrong-key-denied')

    const replay = await exchange(firstDelegation, proofKey())
    assert.equal(replay.status, 400)
    passed.push('delegation-replay-denied')

    const secondDelegation = await getDelegation(page)
    const proofless = await exchangeWithoutProof(secondDelegation)
    assert.equal(proofless.status, 400)
    const retry = await exchange(secondDelegation, proofKey())
    assert.equal(retry.status, 200)
    passed.push('missing-proof-preserves-delegation')

    const thirdDelegation = await getDelegation(page)
    const ambiguous = await exchange(thirdDelegation, proofKey(), {
      space,
      delegationToken: thirdDelegation,
    })
    assert.equal(ambiguous.status, 400)
    const afterAmbiguous = await exchange(thirdDelegation, proofKey())
    assert.equal(afterAmbiguous.status, 200)
    passed.push('ambiguous-transport-denied')

    const ordinaryBearer = await exchange(
      'header.payload.signature',
      proofKey(),
    )
    assert.ok([400, 401].includes(ordinaryBearer.status))
    passed.push('ordinary-bearer-denied')

    console.log(
      JSON.stringify({
        suite: 'delegation-transport',
        assertions: passed.map((id) => ({ id, status: 'passed' })),
      }),
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(
    `Delegation transport scenario failed: ${error instanceof Error ? error.name : 'UnknownError'}`,
  )
  process.exitCode = 1
})
