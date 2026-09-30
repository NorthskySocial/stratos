#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire('/runner/feedgen-ng-e2e-browser.mjs')
const { chromium } = require('playwright')
const collection = 'zone.stratos.feed.post'
const createPath = '/xrpc/com.atproto.space.createRecord'
const deletePath = '/xrpc/com.atproto.space.deleteRecord'
const feedPath = '/xrpc/zone.stratos.feedgen.getFeed'

async function trustSandboxCa() {
  const cert = '/ca/root.crt'
  await readFile(cert)
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
    // An existing browser profile can already hold the sandbox CA.
  }
  execFileSync(
    'certutil',
    [
      '-A',
      '-d',
      `sql:${database}`,
      '-n',
      'space-delete-sandbox',
      '-t',
      'C,,',
      '-i',
      cert,
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
  let leftApp = false
  while (Date.now() < deadline) {
    const current = new URL(page.url())
    if (current.origin !== origin) leftApp = true
    if (leftApp && current.origin === origin) return
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
  const current = new URL(page.url())
  const summary = (
    await page
      .locator('body')
      .innerText()
      .catch(() => '')
  ).slice(-600)
  throw new Error(
    `Webapp OAuth did not return from the private PDS (${current.origin}${current.pathname}: ${summary})`,
  )
}

async function signIn(page, account, appUrl) {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('#handle').fill(account.username)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await completeOAuth(page, account, new URL(appUrl).origin)
  await page
    .getByRole('button', { name: 'Log Out' })
    .waitFor({ timeout: 30_000 })
  await page.locator('#post-text').waitFor({ timeout: 30_000 })
}

function collectFeedResponses(page) {
  const responses = []
  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== feedPath) return
    void response
      .json()
      .then((body) => {
        responses.push({ status: response.status(), body })
      })
      .catch(() => {})
  })
  return responses
}

function feedContains(responses, uri) {
  return responses.some(
    ({ status, body }) =>
      status === 200 &&
      Array.isArray(body?.feed) &&
      body.feed.some((item) => item?.post?.uri === uri),
  )
}

async function waitForFeed(page, responses, uri, text) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (
      feedContains(responses, uri) &&
      (await visible(page.locator('.post-card', { hasText: text }).first()))
    )
      return
    await page.reload({ waitUntil: 'domcontentloaded' })
    await delay(1_000)
  }
  throw new Error('Rust feed did not show the space post')
}

async function createPrivateFixture(pds, session, text) {
  const space =
    'at://did:web:stratos-e2e.atmosbox.test/space/zone.stratos.space.feed/general'
  const created = await requestJson(`${pds}${createPath}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.accessJwt}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      space,
      repo: session.did,
      collection,
      record: {
        $type: collection,
        text,
        createdAt: new Date().toISOString(),
      },
    }),
  })
  assert.ok(created.uri?.includes(`/${session.did}/${collection}/`))
  return created.uri
}

async function deletePrivatePost(page, text, expected) {
  const card = page.locator('.post-card', { hasText: text }).first()
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === deletePath,
    { timeout: 45_000 },
  )
  await card.getByRole('button', { name: 'Delete post' }).click()
  const response = await responsePromise
  assert.equal(response.status(), 200, 'OAuth PDS space deletion failed')
  assert.deepEqual(JSON.parse(response.request().postData() || '{}'), expected)
}

async function waitForRemoval(
  page,
  responses,
  removed,
  retained,
  retainedText,
) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const previous = responses.length
    await page.reload({ waitUntil: 'domcontentloaded' })
    await delay(1_000)
    const latest = responses
      .slice(previous)
      .findLast(({ status }) => status === 200)
    if (latest && Array.isArray(latest.body?.feed)) {
      const uris = latest.body.feed.map((item) => item?.post?.uri)
      if (
        !uris.includes(removed) &&
        uris.includes(retained) &&
        (await visible(
          page.locator('.post-card', { hasText: retainedText }).first(),
        ))
      )
        return
    }
  }
  throw new Error('Rust feed did not remove only the deleted post')
}

async function requestJson(url, options) {
  const response = await fetch(url, options)
  assert.equal(response.status, 200, `PDS request failed (${response.status})`)
  return response.json()
}

async function createSecondAccount(domain, password) {
  const pds = `https://spaces-pds-e2e.${domain}`
  const adminPassword = (
    await readFile('/run/sandbox-secrets/pds-admin-password', 'utf8')
  ).trim()
  const basic = Buffer.from(`admin:${adminPassword}`).toString('base64')
  const invite = await requestJson(
    `${pds}/xrpc/com.atproto.server.createInviteCode`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ useCount: 1 }),
    },
  )
  const username = `asuka.spaces-pds-e2e.${domain}`
  const session = await requestJson(
    `${pds}/xrpc/com.atproto.server.createAccount`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `asuka@spaces-pds-e2e.${domain}`,
        handle: username,
        password,
        inviteCode: invite.code,
      }),
    },
  )
  return { username, password, did: session.did, session, pds }
}

async function assertStratosDelete(browser, domain, appUrl) {
  const state = JSON.parse(
    await readFile('/sandbox-state/accounts.json', 'utf8'),
  )
  const username = `user1.pds1.${domain}`
  const account = state.accounts?.[username]
  assert.ok(
    account?.password && account?.did,
    'Stratos custody actor was not seeded',
  )
  const page = await browser.newPage()
  const responses = collectFeedResponses(page)
  await signIn(page, { username, password: account.password }, appUrl)
  let record
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    record = responses
      .filter(({ status }) => status === 200)
      .flatMap(({ body }) => body?.feed ?? [])
      .map((item) => item?.post)
      .find(
        (post) =>
          post?.uri?.startsWith(`at://${account.did}/${collection}/`) &&
          post?.record?.text?.startsWith('Stratos custody sandbox E2E '),
      )
    if (
      record &&
      (await visible(
        page.locator('.post-card', { hasText: record.record.text }).first(),
      ))
    )
      break
    await page.reload({ waitUntil: 'domcontentloaded' })
    await delay(1_000)
  }
  assert.ok(record, 'Baseline Stratos custody fixture did not reach the feed')

  const deletedPromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname ===
        '/xrpc/com.atproto.repo.deleteRecord',
    { timeout: 45_000 },
  )
  await page
    .locator('.post-card', { hasText: record.record.text })
    .first()
    .getByRole('button', { name: 'Delete post' })
    .click()
  const deleted = await deletedPromise
  assert.equal(deleted.status(), 200, 'Stratos custody post deletion failed')
  assert.deepEqual(JSON.parse(deleted.request().postData() || '{}'), {
    repo: account.did,
    collection,
    rkey: record.uri.split('/').at(-1),
  })
  const removalDeadline = Date.now() + 120_000
  while (Date.now() < removalDeadline) {
    const prior = responses.length
    await page.reload({ waitUntil: 'domcontentloaded' })
    await delay(1_000)
    const latest = responses
      .slice(prior)
      .findLast(({ status }) => status === 200)
    if (
      latest &&
      Array.isArray(latest.body?.feed) &&
      latest.body.feed.every((item) => item?.post?.uri !== record.uri)
    )
      return
  }
  throw new Error('Rust feed kept the deleted Stratos custody post')
}

async function main() {
  const domain = process.env.SANDBOX_DOMAIN
  assert.equal(domain, 'atmosbox.test')
  await trustSandboxCa()
  const password = (
    await readFile('/run/sandbox-secrets/browser-password', 'utf8')
  ).trim()
  const pds = `https://spaces-pds-e2e.${domain}`
  const account = {
    username: `motoko.spaces-pds-e2e.${domain}`,
    password,
  }
  const session = await requestJson(
    `${pds}/xrpc/com.atproto.server.createSession`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: account.username, password }),
    },
  )
  const appUrl = 'https://webapp-e2e.atmosbox.internal'
  const metadataResponse = await fetch(`${appUrl}/client-metadata.json`)
  assert.equal(metadataResponse.status, 200)
  assert.equal(metadataResponse.headers.get('content-type'), 'application/json')
  const metadata = await metadataResponse.json()
  const spaceScope = metadata.scope
    .split(' ')
    .find((scope) => scope.startsWith('space:'))
  assert.ok(spaceScope?.endsWith('&action=read&action=create&action=delete'))
  assert.equal(spaceScope.match(/action=delete/g)?.length, 1)

  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const feedResponses = collectFeedResponses(page)
    await signIn(page, account, appUrl)
    const targetText = `Space delete ${randomUUID()}`
    const retainedText = `Space retain ${randomUUID()}`
    const target = await createPrivateFixture(pds, session, targetText)
    const retained = await createPrivateFixture(pds, session, retainedText)
    await waitForFeed(page, feedResponses, target, targetText)
    await waitForFeed(page, feedResponses, retained, retainedText)

    await assertStratosDelete(browser, domain, appUrl)

    const parts = target.slice('at://'.length).split('/')
    const deleteTarget = {
      space: `at://${parts.slice(0, 4).join('/')}`,
      repo: session.did,
      collection,
      rkey: parts[6],
    }
    await deletePrivatePost(page, targetText, deleteTarget)
    await waitForRemoval(page, feedResponses, target, retained, retainedText)

    const other = await createSecondAccount(domain, password)
    const otherPage = await browser.newPage()
    const syntheticText = `Other actor delete probe ${randomUUID()}`
    const syntheticUri = retained.replace(`/${session.did}/`, `/${other.did}/`)
    assert.notEqual(syntheticUri, retained)
    // The second actor has no Stratos membership. Supply one local UI fixture so
    // its real webapp OAuth session can issue a delete request to the PDS.
    await otherPage.route(`**${feedPath}**`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue()
        return
      }
      const upstream = await route.fetch()
      await route.fulfill({
        response: upstream,
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          feed: [
            {
              post: {
                uri: syntheticUri,
                cid: 'bafyreidummyfixture',
                author: { did: other.did, handle: other.username },
                record: {
                  text: syntheticText,
                  createdAt: new Date().toISOString(),
                },
                boundaries: ['general'],
              },
            },
          ],
        }),
      })
    })
    await signIn(otherPage, other, appUrl)
    const syntheticCard = otherPage
      .locator('.post-card', { hasText: syntheticText })
      .first()
    await syntheticCard.waitFor({ timeout: 30_000 })
    assert.equal(
      await visible(
        otherPage
          .locator('.post-card', { hasText: retainedText })
          .getByRole('button', { name: 'Delete post' }),
      ),
      false,
    )
    const deniedTarget = {
      ...deleteTarget,
      rkey: retained.split('/').at(-1),
    }
    let oauthHeaders
    let originalTarget
    await otherPage.route(`**${deletePath}`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      oauthHeaders = route.request().headers()
      originalTarget = route.request().postDataJSON()
      // DPoP binds the browser grant to the URL and method, not the JSON body.
      // Send the other actor's genuine OAuth request against the first actor's
      // retained record and let the PDS reject the cross-account delete.
      await route.continue({ postData: JSON.stringify(deniedTarget) })
    })
    const deniedPromise = otherPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === deletePath,
      { timeout: 45_000 },
    )
    await syntheticCard.getByRole('button', { name: 'Delete post' }).click()
    const denied = await deniedPromise
    assert.deepEqual(originalTarget, {
      ...deniedTarget,
      repo: other.did,
    })
    assert.match(oauthHeaders?.authorization ?? '', /^DPoP /i)
    assert.ok(oauthHeaders?.dpop, 'Other actor request lacked a DPoP proof')
    assert.ok(
      [400, 401, 403].includes(denied.status()),
      'Other actor unexpectedly deleted the record',
    )
    await waitForFeed(page, feedResponses, retained, retainedText)

    console.log(
      JSON.stringify({
        suite: 'space-delete',
        assertions: [
          'webapp-oauth-delete-grant',
          'pds-delete-target',
          'feed-removes-only-target',
          'other-author-denied',
          'stratos-delete-preserved',
        ].map((id) => ({
          id,
          status: 'passed',
          ...(id === 'pds-delete-target'
            ? {
                detail:
                  'Synthetic PDS session created fixture posts; candidate webapp OAuth deleted the target.',
              }
            : id === 'other-author-denied'
              ? {
                  detail:
                    'Synthetic feed card prompted the second actor webapp OAuth request; PDS denied its cross-account delete.',
                }
              : {}),
        })),
      }),
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(
    'Space delete browser E2E failed:',
    error instanceof Error ? error.message : String(error),
  )
  process.exitCode = 1
})
