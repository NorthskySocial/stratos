#!/usr/bin/env -S deno run -A
// Admin API phase — proves boundary management through the *admin API* (real
// OAuth login, not a dev Bearer shortcut, which the verifier rejects by design).
//
// Unlike configure-boundaries.ts (direct DB writes), this exercises:
//   1. a genuine admin OAuth login via Playwright → captures the session cookie
//   2. boundary mutations via zone.stratos.admin.* using that cookie
//   3. a two-way cross-check: the DB reflects the change AND the user's PDS
//      enrollment record was rewritten (the part the direct-DB phase cannot cover)
//   4. a negative case: the same mutation without the cookie → 401
//
// Skips cleanly under --direct (no real OAuth session, no PDS-record sync).

import { type Browser, chromium, type Page } from 'npm:playwright@1.58.2'
import {
  ADMIN_OPERATOR_KEY,
  ADMIN_TARGET_KEY,
  DOMAINS,
  PDS_URL,
  STRATOS_URL,
} from './lib/config.ts'
import { ADMIN_SESSION_COOKIE } from './lib/admin.ts'
import { getBoundaries } from './lib/backend.ts'
import { enrollmentStatus, listPdsRecords } from './lib/stratos.ts'
import { loadState, type UserState } from './lib/state.ts'
import { dim, fail, info, pass, section, summary } from './lib/log.ts'

const ENROLLMENT_COLLECTION = 'zone.stratos.actor.enrollment'
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
    await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: true })
    dim(`Screenshot saved: test-data/screenshots/${name}.png`)
  } catch {
    dim(`Failed to save screenshot: ${name}.png`)
  }
}

/**
 * Drive the admin OAuth flow for the operator and return the opaque admin
 * session cookie value. Mirrors the enrollment OAuth flow but targets the admin
 * authorize/callback routes; the cookie is set on the callback response, so it
 * is present in the browser context even though /admin itself has no page yet.
 */
async function adminLogin(
  browser: Browser,
  handle: string,
  password: string,
): Promise<string | null> {
  const baseUrl = await getBaseUrl()
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.setExtraHTTPHeaders({ 'ngrok-skip-browser-warning': 'true' })
  const page = await context.newPage()

  try {
    const authorizeUrl = `${baseUrl}/admin/oauth/authorize?handle=${encodeURIComponent(handle)}`
    info(`Operator: starting admin OAuth at ${authorizeUrl}`)
    await page.goto(authorizeUrl, { waitUntil: 'load', timeout: 30_000 })
    await handleNgrokInterstitial(page)

    await page.waitForSelector('input[type="password"], input[name="password"]', {
      timeout: 15_000,
    })
    const usernameInput =
      (await page.$('input[name="username"]:not([readonly]):not([disabled])')) ??
      (await page.$('input[name="identifier"]:not([readonly]):not([disabled])'))
    if (usernameInput && !(await usernameInput.inputValue())) {
      await usernameInput.fill(handle)
    }
    await page.fill('input[type="password"], input[name="password"]', password)
    await page.keyboard.press('Enter')

    // Either we land back on the service (callback) or hit a consent screen.
    await page.waitForURL(
      (url: URL) => {
        const s = url.toString()
        return s.includes('/admin') || s.includes('authorize') || s.includes('consent')
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
      await page
        .waitForURL((url: URL) => url.toString().includes(baseUrl), {
          timeout: 15_000,
        })
        .catch(() => {
          // /admin has no page yet (plan 004); the cookie is already set.
        })
    }

    await page.waitForTimeout(500)
    const cookies = await context.cookies()
    const sessionCookie = cookies.find((c) => c.name === ADMIN_SESSION_COOKIE)
    return sessionCookie?.value ?? null
  } catch (err) {
    await screenshot(page, 'admin-login-error')
    fail('Admin OAuth login threw', err instanceof Error ? err.message : String(err))
    return null
  } finally {
    await context.close()
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

interface BoundaryResponse {
  did: string
  boundaries: string[]
}

async function adminFetch(
  path: string,
  body: Record<string, unknown>,
  sessionCookie: string | null,
): Promise<{ status: number; body: unknown }> {
  const baseUrl = await getBaseUrl()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'ngrok-skip-browser-warning': 'true',
  }
  if (sessionCookie) {
    headers['Cookie'] = `${ADMIN_SESSION_COOKIE}=${sessionCookie}`
  }
  const res = await fetch(`${baseUrl}/xrpc/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    parsed = undefined
  }
  return { status: res.status, body: parsed }
}

/** Read the boundaries recorded on the user's PDS enrollment record. */
async function readPdsBoundaries(did: string): Promise<string[] | null> {
  const result = await listPdsRecords(PDS_URL, did, ENROLLMENT_COLLECTION)
  const record = result.records[0]
  if (!record) return null
  const value = record.value as { boundaries?: Array<{ value?: string }> }
  if (!Array.isArray(value.boundaries)) return []
  return value.boundaries
    .map((b) => b.value)
    .filter((v): v is string => typeof v === 'string')
}

/** Poll the PDS until its enrollment record matches the expected boundary set. */
async function waitForPdsBoundaries(
  did: string,
  expected: string[],
  timeoutMs = 10_000,
): Promise<string[] | null> {
  const want = new Set(expected)
  const deadline = Date.now() + timeoutMs
  let last: string[] | null = null
  while (Date.now() < deadline) {
    last = await readPdsBoundaries(did)
    if (
      last &&
      last.length === want.size &&
      last.every((b) => want.has(b))
    ) {
      return last
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  return last
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((v) => set.has(v))
}

async function run(): Promise<void> {
  section('Admin API: Boundary Management')

  if (Deno.env.get('STRATOS_E2E_DIRECT') === 'true') {
    info(
      'Direct mode: admin API phase requires a real OAuth login + live target session — skipping.',
    )
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

  // Precondition: both users must be enrolled from the earlier phase.
  for (const [label, user] of [
    ['operator', operator],
    ['target', target],
  ] as Array<[string, UserState]>) {
    const status = await enrollmentStatus(user.did).catch(() => null)
    if (!status?.enrolled) {
      fail(
        `${label} not enrolled`,
        `${user.handle} (${user.did}) must be enrolled before the admin phase`,
      )
      Deno.exit(1)
    }
  }

  info('Performing real admin OAuth login (no dev bypass)...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  let sessionCookie: string | null = null
  try {
    sessionCookie = await adminLogin(browser, operator.handle, operator.password)
  } finally {
    await browser.close()
  }

  assert(
    sessionCookie,
    'Captured admin session cookie from OAuth login',
    sessionCookie ? 'cookie present' : 'no cookie — STOP-worthy per plan 003',
  )
  if (!sessionCookie) {
    // Per plan 003 STOP condition: do not fall back to a Bearer shortcut.
    summary(passed, failed)
    Deno.exit(1)
  }

  // 1. "User appears in the admin panel" — lookup the enrolled target by DID.
  const lookup = await enrollmentStatus(target.did)
  assert(
    lookup.enrolled,
    'Admin lookup: target user appears as enrolled',
    `${target.handle} (${target.did})`,
  )

  // 2. addBoundary via the admin API.
  const add = await adminFetch(
    'zone.stratos.admin.addBoundary',
    { did: target.did, boundary: DOMAINS.aekea },
    sessionCookie,
  )
  const addBody = add.body as BoundaryResponse
  assert(
    add.status === 200 && addBody?.boundaries?.includes(DOMAINS.aekea),
    'addBoundary returns the added boundary',
    `status=${add.status}, boundaries=[${addBody?.boundaries?.join(', ') ?? ''}]`,
  )

  // 3a. DB cross-check.
  const dbAfterAdd = await getBoundaries(target.did)
  assert(
    dbAfterAdd.includes(DOMAINS.aekea),
    'DB reflects the added boundary',
    `[${dbAfterAdd.join(', ')}]`,
  )

  // 3b. PDS cross-check — the part the direct-DB phase cannot cover.
  const pdsAfterAdd = await waitForPdsBoundaries(target.did, dbAfterAdd)
  assert(
    pdsAfterAdd !== null && pdsAfterAdd.includes(DOMAINS.aekea),
    'PDS enrollment record rewritten with the added boundary',
    pdsAfterAdd ? `[${pdsAfterAdd.join(', ')}]` : 'no PDS record found',
  )

  // 4. setBoundaries via the admin API to a single known boundary.
  const set = await adminFetch(
    'zone.stratos.admin.setBoundaries',
    { did: target.did, boundaries: [DOMAINS.swordsmith] },
    sessionCookie,
  )
  const setBody = set.body as BoundaryResponse
  assert(
    set.status === 200 && sameSet(setBody?.boundaries ?? [], [DOMAINS.swordsmith]),
    'setBoundaries replaces the boundary set',
    `status=${set.status}, boundaries=[${setBody?.boundaries?.join(', ') ?? ''}]`,
  )

  const dbAfterSet = await getBoundaries(target.did)
  assert(
    sameSet(dbAfterSet, [DOMAINS.swordsmith]),
    'DB reflects setBoundaries',
    `[${dbAfterSet.join(', ')}]`,
  )
  const pdsAfterSet = await waitForPdsBoundaries(target.did, [DOMAINS.swordsmith])
  assert(
    pdsAfterSet !== null && sameSet(pdsAfterSet, [DOMAINS.swordsmith]),
    'PDS enrollment record reflects setBoundaries',
    pdsAfterSet ? `[${pdsAfterSet.join(', ')}]` : 'no PDS record found',
  )

  // 5. removeBoundary via the admin API.
  const remove = await adminFetch(
    'zone.stratos.admin.removeBoundary',
    { did: target.did, boundary: DOMAINS.swordsmith },
    sessionCookie,
  )
  const removeBody = remove.body as BoundaryResponse
  assert(
    remove.status === 200 && !removeBody?.boundaries?.includes(DOMAINS.swordsmith),
    'removeBoundary drops the boundary',
    `status=${remove.status}, boundaries=[${removeBody?.boundaries?.join(', ') ?? ''}]`,
  )

  // 6. Negative case: same mutation with no session cookie → 401.
  const unauth = await adminFetch(
    'zone.stratos.admin.addBoundary',
    { did: target.did, boundary: DOMAINS.aekea },
    null,
  )
  assert(
    unauth.status === 401,
    'addBoundary without session cookie is rejected (401)',
    `status=${unauth.status}`,
  )

  summary(passed, failed)
  if (failed > 0) Deno.exit(1)
}

run().catch((err) => {
  console.error('\nAdmin API phase failed:', err)
  Deno.exit(1)
})
