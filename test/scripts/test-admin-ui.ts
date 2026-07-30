#!/usr/bin/env -S deno run -A
// Admin UI phase — drives the *built* admin SPA served by the service at
// /admin through a headless browser. Builds on the admin OAuth infrastructure
// proven by test-admin-api.ts; here we only assert that the UI drives it:
//   1. unauthenticated /admin renders the Login screen; /admin/whoami is 401
//   2. OAuth sign-in through the UI lands back on /admin authenticated
//   3. the enrolled target user appears on the Enrollments screen
//   4. a boundary toggled via the UI (add + remove) is reflected on screen
//   5. logout returns to the Login screen and the session stays dead on reload
//
// Skips cleanly under --direct (no real OAuth session available).

import { type Browser, chromium, type Page } from 'npm:playwright@1.58.2'
import {
  ADMIN_OPERATOR_KEY,
  ADMIN_TARGET_KEY,
  DOMAINS,
  STRATOS_URL,
} from './lib/config.ts'
import { loadState } from './lib/state.ts'
import { dim, fail, info, pass, section, summary } from './lib/log.ts'

const SCREENSHOT_DIR = new URL('../test-data/screenshots', import.meta.url)
  .pathname

let passed = 0
let failed = 0

function assert(condition: unknown, name: string, detail?: string): void {
  if (condition) {
    pass(name, detail)
    passed++
  } else {
    fail(name, detail)
    failed++
  }
}

async function getBaseUrl(): Promise<string> {
  const state = await loadState()
  return state.ngrokUrl || STRATOS_URL
}

async function screenshot(page: Page, name: string): Promise<void> {
  try {
    await Deno.mkdir(SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/${name}.png`,
      fullPage: true,
    })
    dim(`Screenshot saved: test-data/screenshots/${name}.png`)
  } catch {
    dim(`Failed to save screenshot: ${name}.png`)
  }
}

async function handleNgrokInterstitial(page: Page): Promise<void> {
  const ngrokButton = await page.$(
    'button:has-text("Visit Site"), button:has-text("Visit the site")',
  )
  if (!ngrokButton && !page.url().includes('ngrok-free.app')) return
  if (ngrokButton) {
    await ngrokButton.click()
    await page
      .waitForNavigation({ waitUntil: 'networkidle', timeout: 30_000 })
      .catch(() => {})
  }
}

/** Complete the PDS login + consent screens after the UI started the flow. */
async function completePdsLogin(page: Page, password: string): Promise<void> {
  await handleNgrokInterstitial(page)
  await page.waitForSelector('input[type="password"], input[name="password"]', {
    timeout: 15_000,
  })
  await page.fill('input[type="password"], input[name="password"]', password)
  await page.keyboard.press('Enter')

  await page.waitForURL(
    (url: URL) => {
      const s = url.toString()
      return (
        s.includes('/admin') || s.includes('authorize') || s.includes('consent')
      )
    },
    { timeout: 15_000 },
  )

  if (!page.url().includes('/admin')) {
    await page.waitForTimeout(1_000)
    const acceptButton =
      (await page.$('button:has-text("Accept")')) ??
      (await page.$('button:has-text("Authorize")')) ??
      (await page.$('button:has-text("Allow")')) ??
      (await page.$('button[type="submit"]'))
    if (acceptButton) {
      await acceptButton.click()
    } else {
      await page.keyboard.press('Enter')
    }
  }
}

async function run(): Promise<void> {
  section('Admin UI: SPA Smoke Tests')

  if (Deno.env.get('STRATOS_E2E_DIRECT') === 'true') {
    info('Direct mode: admin UI phase requires a real OAuth login — skipping.')
    return
  }

  const state = await loadState()
  const operator = state.users[ADMIN_OPERATOR_KEY]
  const target = state.users[ADMIN_TARGET_KEY]
  if (!operator || !target) {
    fail(
      'Missing operator/target user state',
      `operator=${ADMIN_OPERATOR_KEY}, target=${ADMIN_TARGET_KEY} — run setup.ts first`,
    )
    Deno.exit(1)
  }

  const baseUrl = await getBaseUrl()

  // 1a. The built SPA is served at /admin.
  const spaRes = await fetch(`${baseUrl}/admin/`, {
    headers: { 'ngrok-skip-browser-warning': 'true' },
  })
  const spaHtml = await spaRes.text()
  assert(
    spaRes.status === 200 && spaHtml.includes('Northsky Admin'),
    'GET /admin serves the built SPA',
    `status=${spaRes.status}`,
  )

  // 1b. whoami without a session is 401 (and never SPA HTML).
  const whoamiRes = await fetch(`${baseUrl}/admin/whoami`, {
    headers: { 'ngrok-skip-browser-warning': 'true' },
  })
  assert(
    whoamiRes.status === 401,
    '/admin/whoami rejects unauthenticated request (401, not SPA HTML)',
    `status=${whoamiRes.status}`,
  )
  await whoamiRes.body?.cancel()

  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.setExtraHTTPHeaders({ 'ngrok-skip-browser-warning': 'true' })
  const page = await context.newPage()

  try {
    // 2. Unauthenticated /admin shows the Login screen.
    await page.goto(`${baseUrl}/admin/`, {
      waitUntil: 'load',
      timeout: 30_000,
    })
    await page.waitForSelector('[data-testid="login-screen"]', {
      timeout: 15_000,
    })
    assert(true, 'Unauthenticated /admin renders the Login screen')

    // 3. Sign in through the UI → PDS OAuth → back on /admin authenticated.
    await page.fill('[data-testid="handle-input"]', operator.handle)
    await page.click('[data-testid="oauth-signin"]')
    await completePdsLogin(page, operator.password)

    await page.waitForSelector('[data-testid="admin-shell"]', {
      timeout: 20_000,
    })
    const shownDid = await page.textContent('[data-testid="whoami-did"]')
    assert(
      shownDid?.includes(operator.did) === true,
      'Authenticated shell shows the operator identity from whoami',
      `shown=${shownDid?.trim()}`,
    )
    await screenshot(page, 'admin-ui-01-authenticated')

    // 4. Enrollments screen: the enrolled target appears via DID lookup.
    await page.click('a[href="#/enrollments"]')
    await page.fill('[data-testid="did-input"]', target.did)
    await page.click('[data-testid="did-search"]')
    await page.waitForSelector('[data-testid="enrollment-detail"]', {
      timeout: 15_000,
    })
    const detailText = await page.textContent(
      '[data-testid="enrollment-detail"]',
    )
    assert(
      detailText?.includes('enrolled') === true,
      'Target user appears in the admin panel as enrolled',
      `${target.handle} (${target.did})`,
    )
    await screenshot(page, 'admin-ui-02-enrollment-detail')

    // 5. Boundary toggle via the UI: add aekea, then remove it (restores the
    // state test-admin-api.ts left behind). API/DB/PDS correctness is already
    // proven there; here we only assert the UI drives and reflects it.
    const aekeaChip = page
      .locator('[data-testid="boundary-chip"]')
      .filter({ hasText: 'aekea' })

    await page.selectOption('[data-testid="add-boundary-select"]', {
      value: DOMAINS.aekea,
    })
    await page.click('[data-testid="add-boundary"]')
    await aekeaChip.waitFor({ state: 'visible', timeout: 15_000 })
    assert(true, 'Boundary added via the UI appears as a chip', DOMAINS.aekea)
    await screenshot(page, 'admin-ui-03-boundary-added')

    await aekeaChip.locator('[data-testid="boundary-chip-remove"]').click()
    await aekeaChip.waitFor({ state: 'detached', timeout: 15_000 })
    assert(true, 'Boundary removed via the UI disappears', DOMAINS.aekea)

    // 6. Logout returns to the Login screen; a reload stays unauthenticated.
    await page.click('[data-testid="logout"]')
    await page.waitForSelector('[data-testid="login-screen"]', {
      timeout: 15_000,
    })
    assert(true, 'Logout returns to the Login screen')

    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[data-testid="login-screen"]', {
      timeout: 15_000,
    })
    assert(true, 'Reload after logout stays unauthenticated')
  } catch (err) {
    await screenshot(page, 'admin-ui-error')
    // fail() only prints; assert() owns the counter, so increment it here or
    // the phase would exit 0 on any thrown error (e.g. a selector timeout).
    failed++
    fail(
      'Admin UI flow threw',
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    await context.close()
    await browser.close()
  }

  summary(passed, failed)
  if (failed > 0) Deno.exit(1)
}

run().catch((err) => {
  console.error('\nAdmin UI phase failed:', err)
  Deno.exit(1)
})
