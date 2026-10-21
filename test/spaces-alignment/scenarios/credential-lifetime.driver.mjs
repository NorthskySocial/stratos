import assert from 'node:assert/strict'

let assertionLabel
function check(condition, label) {
  assertionLabel = label
  assert.ok(condition, label)
}
async function checkResponse(response, status, label, code) {
  assertionLabel = label
  let errorCode
  if (code !== undefined) {
    const body = await response.json()
    errorCode = body.error === code ? code : 'UnexpectedErrorCode'
  }
  if (response.status !== status || errorCode !== code) {
    const error = new Error()
    error.outcome = {
      label,
      status: response.status,
      expectedStatus: status,
      errorCode,
    }
    throw error
  }
}
function failureOutcome(error) {
  return JSON.stringify(
    error.outcome ?? { label: assertionLabel, status: 'failed' },
  )
}
import {
  proofKey,
  signedHeaders,
} from './standard-credential-transport.driver.mjs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire('/runner/feedgen-ng-e2e-browser.mjs')
const { chromium } = require('playwright')
const domain = process.env.SANDBOX_DOMAIN
check(/^[a-z0-9.-]+$/.test(domain ?? ''), 'sandbox-domain')
const clubhouse = 'https://clubhouse-e2e.atmosbox.internal'
const authority = 'https://stratos-e2e.atmosbox.internal'
const pds = `https://pds-space1.${domain}`
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
  const username = `motoko.pds-space1.${domain}`
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
  check(did.startsWith('did:'), 'oauth-account-did')
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

async function exchange(token, key, body = { space }) {
  const response = await fetch(mintUrl, {
    method: 'POST',
    headers: {
      ...signedHeaders(`Bearer ${token}`, key),
      'content-type': 'application/json',
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
    const delegation = await getDelegation(page)
    const claims = JSON.parse(
      Buffer.from(delegation.split('.')[1], 'base64url'),
    )
    check(claims.iss === did, 'delegation-iss')
    check(claims.sub === space, 'delegation-sub')
    check(claims.aud === `${authorityDid}#atproto_space_host`, 'delegation-aud')
    passed.push('pds-issued-delegation')

    const key = proofKey()
    const mint = await exchange(delegation, key)
    await checkResponse(mint, 200, 'credential-mint')
    const credential = (await mint.json()).credential
    check(typeof credential === 'string', 'credential-string')
    passed.push('credential-minted')

    const localUrl = new URL('/xrpc/zone.stratos.space.listRepos', authority)
    localUrl.searchParams.set('space', space)
    const foreignUrl = new URL('/xrpc/com.atproto.space.listRecords', pds)
    foreignUrl.searchParams.set('space', space)
    foreignUrl.searchParams.set('repo', did)
    foreignUrl.searchParams.set('collection', 'zone.stratos.feed.post')
    async function read(url, presentationKey = key) {
      return fetch(url, {
        headers: {
          ...signedHeaders(
            `Atproto-Space ${credential}`,
            presentationKey,
            url === localUrl ? authorityDid : did,
          ),
        },
      })
    }
    const localBefore = await read(localUrl)
    await checkResponse(localBefore, 200, 'local-read-before-removal')
    passed.push('local-read-before-removal')
    const foreignBefore = await read(foreignUrl)
    await checkResponse(foreignBefore, 200, 'foreign-read-before-removal')
    check(
      (await foreignBefore.json()).records.length > 0,
      'foreign-records-before-removal',
    )
    passed.push('foreign-read-before-removal')

    const removed = await page.evaluate(async (authorityUrl) => {
      const session = window.delegationScenarioAuth.getSession()
      if (!session) throw Error('OAuth session unavailable for removal')
      const response = await session.fetchHandler(
        new URL('/oauth/revoke', authorityUrl).href,
        { method: 'POST' },
      )
      return response.status
    }, authority)
    check(removed === 200, 'member-removal-status')
    passed.push('member-removed')

    const localAfter = await read(localUrl)
    await checkResponse(localAfter, 200, 'local-read-after-removal')
    check(
      !(await localAfter.json()).repos.some((repo) => repo.did === did),
      'removed-member-not-listed',
    )
    passed.push('local-credential-after-removal')
    const foreignAfter = await read(foreignUrl)
    await checkResponse(foreignAfter, 200, 'foreign-read-after-removal')
    check(
      (await foreignAfter.json()).records.length > 0,
      'foreign-records-after-removal',
    )
    passed.push('foreign-credential-after-removal')
    const wrongKey = await read(foreignUrl, proofKey())
    await checkResponse(wrongKey, 401, 'wrong-key-denied', 'BadSpaceSignature')
    passed.push('wrong-key-denied')

    console.log(
      JSON.stringify({
        suite: 'credential-lifetime',
        assertions: passed.map((id) => ({ id, status: 'passed' })),
      }),
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(`Credential lifetime scenario failed: ${failureOutcome(error)}`)
  process.exitCode = 1
})
