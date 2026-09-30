import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire('/runner/feedgen-ng-e2e-browser.mjs')
const { chromium } = require('playwright')
const domain = process.env.SANDBOX_DOMAIN
assert.equal(domain, 'atmosbox.test')
const pds = `https://spaces-pds-e2e.${domain}`
const clubhouse = `https://clubhouse-e2e.atmosbox.internal`
const account = {
  username: `rei.spaces-pds-e2e.${domain}`,
  password: (
    await readFile('/run/sandbox-secrets/browser-password', 'utf8')
  ).trim(),
}
const adminPassword = (
  await readFile('/run/sandbox-secrets/pds-admin-password', 'utf8')
).trim()

const nss = join(process.env.HOME || '/tmp/config', '.pki', 'nssdb')
await mkdir(nss, { recursive: true })
try {
  execFileSync('certutil', ['-N', '-d', `sql:${nss}`, '--empty-password'], {
    stdio: 'ignore',
  })
} catch {}
execFileSync(
  'certutil',
  [
    '-A',
    '-d',
    `sql:${nss}`,
    '-n',
    'sandbox',
    '-t',
    'C,,',
    '-i',
    '/ca/root.crt',
  ],
  { stdio: 'ignore' },
)

const basic = Buffer.from(`admin:${adminPassword}`).toString('base64')
const invite = await fetch(`${pds}/xrpc/com.atproto.server.createInviteCode`, {
  method: 'POST',
  headers: {
    authorization: `Basic ${basic}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ useCount: 1 }),
})
assert.equal(invite.status, 200, 'Second-account invite failed')
const { code } = await invite.json()
const created = await fetch(`${pds}/xrpc/com.atproto.server.createAccount`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: `rei@spaces-pds-e2e.${domain}`,
    handle: account.username,
    password: account.password,
    inviteCode: code,
  }),
})
assert.equal(created.status, 200, 'Second spaces-PDS account creation failed')
const { did } = await created.json()
assert.match(did, /^did:/)

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
try {
  const visible = (locator) => locator.isVisible().catch(() => false)
  async function clickEnabled(locator) {
    for (let index = 0; index < (await locator.count()); index += 1) {
      const candidate = locator.nth(index)
      if (!(await visible(candidate)) || !(await candidate.isEnabled()))
        continue
      await candidate
        .click({ noWaitAfter: true, timeout: 2_000 })
        .catch(() => {})
      return true
    }
    return false
  }
  async function completeOAuth(origin) {
    const deadline = Date.now() + 60_000
    let left = false
    while (Date.now() < deadline) {
      const current = new URL(page.url())
      if (current.origin !== origin) left = true
      if (left && current.origin === origin) return
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
    const current = new URL(page.url())
    const title = await page.title()
    const heading = await page
      .locator('h1')
      .first()
      .textContent()
      .catch(() => null)
    const live = await page
      .locator('[aria-live]')
      .first()
      .textContent()
      .catch(() => null)
    throw new Error(
      `Second-account OAuth timed out at ${current.origin}${current.pathname}: ${JSON.stringify({ title, heading, live })}`,
    )
  }
  await page.goto(clubhouse, { waitUntil: 'domcontentloaded' })
  await page.locator('#handle').fill(account.username)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await completeOAuth(new URL(clubhouse).origin)
  await page
    .locator('.signed-in-account')
    .waitFor({ state: 'visible', timeout: 30_000 })
  const card = page.locator('.room-card', {
    has: page.locator('a.room-link[href="/rooms/general"]'),
  })
  await card.waitFor({ state: 'visible', timeout: 30_000 })
  const join = card.getByRole('button', { name: 'Join room' })
  const actionDeadline = Date.now() + 30_000
  while (Date.now() < actionDeadline && !(await visible(join))) await delay(250)
  assert.ok(
    (await visible(join)) && (await join.isEnabled()),
    'Second account did not receive a room join action',
  )
  await join.click()
  await completeOAuth(new URL(clubhouse).origin)
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const composer = page.locator('#room-post')
    if (await visible(composer)) break
    const recheck = page.getByRole('button', { name: 'Check room again' })
    if (await visible(recheck)) {
      await recheck.click()
      await composer
        .waitFor({ state: 'visible', timeout: 5_000 })
        .catch(() => {})
      if (await visible(composer)) break
    }
    await page.reload({ waitUntil: 'domcontentloaded' })
    await composer.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
  }
  if (!(await visible(page.locator('#room-post')))) {
    const current = new URL(page.url())
    const heading = await page
      .locator('.placeholder-panel h2')
      .first()
      .textContent()
      .catch(() => null)
    const live = await page
      .locator('.live-region')
      .first()
      .textContent()
      .catch(() => null)
    throw new Error(
      `Second account did not join room at ${current.origin}${current.pathname}: ${JSON.stringify({ heading, live })}`,
    )
  }
  const seedText = 'Staging limits secondary repo seed'
  const seedWrite = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname ===
        '/xrpc/com.atproto.repo.createRecord' &&
      response.ok(),
    { timeout: 45_000 },
  )
  await page.locator('#room-post').fill(seedText)
  await page.getByRole('button', { name: 'Post topic' }).click()
  const seedResult = await (await seedWrite).json()
  assert.ok(
    typeof seedResult.uri === 'string' && typeof seedResult.cid === 'string',
    'Second account did not seed its space repo',
  )
  await page.getByText(seedText, { exact: true }).waitFor({
    state: 'visible',
    timeout: 30_000,
  })
  console.log(JSON.stringify({ did }))
} finally {
  await browser.close()
}
