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

async function assertTamperedDelegationDenied(page, key) {
  const token = await getDelegation(page)
  const [header, payload] = token.split('.')
  check(header && payload, 'delegation-jwt-shape')
  const response = await exchange(
    `${header}.${payload}.tampered-signature`,
    key,
  )
  await checkResponse(response, 400, 'tampered-delegation', 'InvalidToken')
  passed.push('tampered-delegation-signature-denied')
}

async function main() {
  await trustSandboxCa()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const did = await oauthSession(page)
    check(clubhouse !== pds, 'authorization-server-pds-separation')
    passed.push('authorization-server-pds-separation')
    const firstDelegation = await getDelegation(page)
    const payload = JSON.parse(
      Buffer.from(firstDelegation.split('.')[1], 'base64url'),
    )
    check(payload.iss === did, 'delegation-iss')
    check(payload.sub === space, 'delegation-sub')
    check(
      payload.aud === `${authorityDid}#atproto_space_host`,
      'delegation-aud',
    )
    passed.push('pds-issued-delegation')

    const key = proofKey()
    const mint = await exchange(firstDelegation, key)
    await checkResponse(mint, 200, 'credential-mint')
    const credential = (await mint.json()).credential
    check(typeof credential === 'string', 'credential-string')
    passed.push('header-exchange')

    const recordsUrl = new URL('/xrpc/com.atproto.space.listRecords', pds)
    recordsUrl.searchParams.set('space', space)
    recordsUrl.searchParams.set('repo', did)
    recordsUrl.searchParams.set('collection', 'zone.stratos.feed.post')
    const recordsResponse = await fetch(recordsUrl, {
      headers: {
        ...signedHeaders(`Atproto-Space ${credential}`, key, did),
      },
    })
    await checkResponse(recordsResponse, 200, 'foreign-repo-read')
    const records = (await recordsResponse.json()).records
    check(
      Array.isArray(records) && records.length > 0,
      'foreign-records-present',
    )
    passed.push('foreign-repo-read')

    await assertTamperedDelegationDenied(page, proofKey())

    const wrongKey = proofKey()
    const wrongKeyResponse = await fetch(recordsUrl, {
      headers: {
        ...signedHeaders(`Atproto-Space ${credential}`, wrongKey, did),
      },
    })
    await checkResponse(
      wrongKeyResponse,
      401,
      'wrong-key-denied',
      'BadSpaceSignature',
    )
    passed.push('wrong-key-denied')

    const replay = await exchange(firstDelegation, proofKey())
    await checkResponse(replay, 400, 'delegation-replay', 'InvalidToken')
    passed.push('delegation-replay-denied')

    const secondDelegation = await getDelegation(page)
    const proofless = await exchangeWithoutProof(secondDelegation)
    await checkResponse(proofless, 400, 'missing-proof', 'ProofRequired')
    const retry = await exchange(secondDelegation, proofKey())
    await checkResponse(retry, 200, 'retry-after-missing-proof')
    passed.push('missing-proof-preserves-delegation')

    const thirdDelegation = await getDelegation(page)
    const ambiguous = await exchange(thirdDelegation, proofKey(), {
      space,
      delegationToken: thirdDelegation,
    })
    await checkResponse(ambiguous, 400, 'ambiguous-transport', 'InvalidRequest')
    const afterAmbiguous = await exchange(thirdDelegation, proofKey())
    await checkResponse(afterAmbiguous, 200, 'retry-after-ambiguous')
    passed.push('ambiguous-transport-denied')

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
    `Delegation transport scenario failed: ${failureOutcome(error)}`,
  )
  process.exitCode = 1
})
