#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire('/runner/feedgen-ng-e2e-browser.mjs')
const { chromium } = require('playwright')
const appUrl = 'https://webapp-e2e.atmosbox.internal'
const control = '/runner/control'
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII=',
  'base64',
)

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
    // A reused disposable browser profile can already contain its database.
  }
  execFileSync(
    'certutil',
    [
      '-A',
      '-d',
      `sql:${database}`,
      '-n',
      'feed-errors-sandbox',
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

async function completeOAuth(page, account) {
  const origin = new URL(appUrl).origin
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
  throw new Error(
    `Webapp OAuth did not return from the private PDS (${current.origin}${current.pathname})`,
  )
}

async function requestJson(url, options) {
  const response = await fetch(url, options)
  assert.equal(
    response.status,
    200,
    `Fixture request failed (${response.status})`,
  )
  return response.json()
}

async function createFixtures(account, domain) {
  const pds = `https://spaces-pds-e2e.${domain}`
  const session = await requestJson(
    `${pds}/xrpc/com.atproto.server.createSession`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: account.username,
        password: account.password,
      }),
    },
  )
  const nonce = randomUUID()
  const publicText = `Public feed error fixture ${nonce}`
  const privateText = `Private feed error fixture ${nonce}`
  const image = await fetch(`${pds}/xrpc/com.atproto.repo.uploadBlob`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.accessJwt}`,
      'content-type': 'image/png',
    },
    body: tinyPng,
  })
  assert.equal(
    image.status,
    200,
    `Fixture blob upload failed (${image.status})`,
  )
  const uploaded = await image.json()
  assert.ok(uploaded.blob, 'Fixture blob upload returned no blob reference')
  await requestJson(`${pds}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.accessJwt}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.feed.post',
      record: {
        $type: 'app.bsky.feed.post',
        text: publicText,
        createdAt: new Date().toISOString(),
      },
    }),
  })
  await requestJson(`${pds}/xrpc/com.atproto.space.createRecord`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.accessJwt}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      space: `at://did:web:stratos-e2e.${domain}/space/zone.stratos.space.feed/general`,
      repo: session.did,
      collection: 'zone.stratos.feed.post',
      record: {
        $type: 'zone.stratos.feed.post',
        text: privateText,
        createdAt: new Date().toISOString(),
        embed: {
          $type: 'zone.stratos.embed.images',
          images: [{ alt: 'Private feed fixture image', image: uploaded.blob }],
        },
      },
    }),
  })
  return { did: session.did, publicText, privateText }
}

async function waitSignal(name) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (
      await stat(path.join(control, name))
        .then(() => true)
        .catch(() => false)
    )
      return
    await delay(250)
  }
  throw new Error(`Timed out waiting for ${name}`)
}

async function publishPublic(page, text) {
  await page.locator('#post-text').fill(text)
  await page.getByRole('button', { name: 'Post', exact: true }).click()
}

async function waitPrivateFixture(page, text) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (
      await visible(
        page.locator('.post-card.private', { hasText: text }).first(),
      )
    )
      return
    await page.reload({ waitUntil: 'domcontentloaded' })
    await delay(1_000)
  }
  throw new Error('Candidate webapp did not render the private fixture')
}

async function privateImage(page, text) {
  const image = page
    .locator('.post-card.private', { hasText: text })
    .locator('img.post-image')
  await image.waitFor({ state: 'attached', timeout: 30_000 })
  return image
}

async function main() {
  const domain = process.env.SANDBOX_DOMAIN
  assert.equal(domain, 'atmosbox.test')
  await trustSandboxCa()
  const account = {
    username: `motoko.spaces-pds-e2e.${domain}`,
    password: (
      await readFile('/run/sandbox-secrets/browser-password', 'utf8')
    ).trim(),
  }
  const fixture = await createFixtures(account, domain)
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' })
    await page.locator('#handle').fill(account.username)
    await page.getByRole('button', { name: 'Sign In' }).click()
    await completeOAuth(page, account)
    await page
      .getByRole('button', { name: 'Log Out' })
      .waitFor({ timeout: 30_000 })
    await waitPrivateFixture(page, fixture.privateText)
    await privateImage(page, fixture.privateText)
    await page.getByText(fixture.publicText).waitFor({ timeout: 30_000 })
    await writeFile(path.join(control, 'ready'), '')

    await waitSignal('interrupted')
    await publishPublic(
      page,
      `Togusa checks the interrupted feed ${randomUUID()}`,
    )
    const status = page.locator('.feed-failure[role="status"]')
    await status.waitFor({ state: 'visible', timeout: 30_000 })
    assert.match(await status.innerText(), /private feed/i)
    assert.ok(
      await visible(page.getByRole('button', { name: 'Retry private feed' })),
    )
    assert.equal(
      await visible(
        page.locator('.post-card.private', { hasText: fixture.privateText }),
      ),
      false,
    )
    assert.ok(await visible(page.getByText(fixture.publicText)))
    await writeFile(path.join(control, 'failed'), '')

    await waitSignal('restored')
    const recoveryDeadline = Date.now() + 120_000
    while (Date.now() < recoveryDeadline) {
      const retry = page.getByRole('button', { name: 'Retry private feed' })
      if (await visible(retry)) await retry.click()
      if (
        await visible(
          page.locator('.post-card.private', { hasText: fixture.privateText }),
        )
      )
        break
      await delay(1_000)
    }
    assert.ok(
      await visible(
        page.locator('.post-card.private', { hasText: fixture.privateText }),
      ),
    )
    assert.ok(await visible(page.getByText(fixture.publicText)))

    const revocationContext = await browser.newContext()
    const revocationPage = await revocationContext.newPage()
    await revocationPage.goto(appUrl, { waitUntil: 'domcontentloaded' })
    await revocationPage.locator('#handle').fill(account.username)
    await revocationPage.getByRole('button', { name: 'Sign In' }).click()
    await completeOAuth(revocationPage, account)
    await revocationPage
      .getByRole('button', { name: 'Log Out' })
      .waitFor({ timeout: 30_000 })
    await waitPrivateFixture(revocationPage, fixture.privateText)
    await privateImage(revocationPage, fixture.privateText)

    let releaseLate
    const lateResponse = new Promise((resolve) => {
      releaseLate = resolve
    })
    let sawLateRequest = false
    await page.route(
      '**/xrpc/zone.stratos.feedgen.getFeed**',
      async (route) => {
        sawLateRequest = true
        await lateResponse
        await route.continue()
      },
    )
    await publishPublic(page, `Batou triggers a late response ${randomUUID()}`)
    const pendingDeadline = Date.now() + 15_000
    while (!sawLateRequest && Date.now() < pendingDeadline) await delay(100)
    assert.ok(
      sawLateRequest,
      'No private feed request was pending before session change',
    )
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: 'Log Out' }).click()
    releaseLate()
    await page
      .getByRole('button', { name: 'Sign In' })
      .waitFor({ timeout: 30_000 })
    assert.equal(await visible(page.locator('.post-card.private')), false)
    await delay(500)
    assert.equal(await visible(page.locator('.post-card.private')), false)

    const privateBlobUrl = await (
      await privateImage(revocationPage, fixture.privateText)
    ).getAttribute('src')
    let releaseRevokedRequest
    const revokedRequest = new Promise((resolve) => {
      releaseRevokedRequest = resolve
    })
    let sawRevokedRequest = false
    const feedPath = '**/xrpc/zone.stratos.feedgen.getFeed**'
    const holdRevokedRequest = async (route) => {
      sawRevokedRequest = true
      await revokedRequest
      await route.continue()
    }
    await revocationPage.route(feedPath, holdRevokedRequest, { times: 1 })
    await publishPublic(
      revocationPage,
      `Saito checks a revoked grant ${randomUUID()}`,
    )
    const revokedDeadline = Date.now() + 15_000
    while (!sawRevokedRequest && Date.now() < revokedDeadline) await delay(100)
    assert.ok(
      sawRevokedRequest,
      'No Feedgen request was pending for grant revocation',
    )
    assert.ok(
      await visible(revocationPage.getByRole('button', { name: 'Log Out' })),
    )
    await writeFile(path.join(control, 'revoke-did'), fixture.did)
    await waitSignal('revoked')
    const deniedResponse = revocationPage.waitForResponse(
      (response) =>
        response.url().includes('/xrpc/zone.stratos.feedgen.getFeed') &&
        [401, 403].includes(response.status()),
      { timeout: 30_000 },
    )
    releaseRevokedRequest()
    await deniedResponse
    const settledDeadline = Date.now() + 30_000
    while (Date.now() < settledDeadline) {
      if (
        (await visible(
          revocationPage.locator('.feed-failure[role="status"]'),
        )) ||
        (await visible(revocationPage.getByRole('button', { name: 'Sign In' })))
      )
        break
      await delay(250)
    }
    assert.ok(
      (await visible(revocationPage.locator('.feed-failure[role="status"]'))) ||
        (await visible(
          revocationPage.getByRole('button', { name: 'Sign In' }),
        )),
      'Authorization loss did not settle the signed-in feed',
    )
    assert.equal(
      await visible(
        revocationPage.locator('.post-card.private', {
          hasText: fixture.privateText,
        }),
      ),
      false,
    )
    assert.equal(
      await revocationPage
        .locator('img.post-image[alt="Private feed fixture image"]')
        .count(),
      0,
    )
    if (privateBlobUrl?.startsWith('blob:')) {
      assert.equal(
        await revocationPage.evaluate(
          async (url) =>
            fetch(url)
              .then(() => true)
              .catch(() => false),
          privateBlobUrl,
        ),
        false,
        'Private image blob URL remained usable after authorization loss',
      )
    }
    await revocationPage.unroute(feedPath, holdRevokedRequest)

    console.log(
      JSON.stringify({
        suite: 'feed-errors',
        assertions: [
          'private-feed-loaded',
          'interrupted-feed-error',
          'public-feed-retained',
          'retry-recovered',
          'revoked-session-cleared',
          'late-response-isolated',
        ].map((id) => ({ id, status: 'passed' })),
      }),
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(
    'Feed errors browser E2E failed:',
    error instanceof Error ? error.message : String(error),
  )
  process.exitCode = 1
})
