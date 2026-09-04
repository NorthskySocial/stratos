#!/usr/bin/env -S deno run -A
// Enrollment test — drives the PDS OAuth flow via Playwright to enroll each user.

import { type Browser, chromium, type Page } from 'npm:playwright@1.58.2'
import { PDS_URL, STRATOS_URL, TEST_USERS } from './lib/config.ts'
import { enrollmentStatus, listPdsRecords } from './lib/stratos.ts'
import { loadState, saveState } from './lib/state.ts'
import {
  fillSignInForm,
  screenshot,
  submitSignInAndConsent,
} from './lib/oauth-flow.ts'
import {
  dim,
  error,
  fail,
  failureCount,
  finish,
  info,
  pass,
  section,
} from './lib/log.ts'

/**
 * Drive the PDS OAuth sign-in + consent flow for one user.
 *
 * Flow:
 *   1. GET /oauth/authorize?handle=<handle> → Stratos starts PAR, redirects to PDS
 *   2. PDS shows sign-in form (loginHint pre-fills username, may be readonly)
 *   3. Enter password + submit
 *   4. PDS shows consent/authorize page
 *   5. Click "Accept" / "Authorize" / "Allow"
 *   6. PDS redirects back to /oauth/callback → Stratos enrolls user
 *   7. Final page shows JSON with {success: true}
 */
async function enrollUser(
  browser: Browser,
  handle: string,
  password: string,
  label: string,
): Promise<{ success: boolean; did?: string; error?: string }> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()

  try {
    await navigateToOAuth(page, handle, label, STRATOS_URL)
    await fillSignInForm(page, handle, password, label)
    await submitSignInAndConsent(page, label, (url) =>
      url.includes(`${STRATOS_URL}/oauth/callback`),
    )
    return await verifyEnrollmentResponse(page, label)
  } catch (err) {
    await screenshot(page, `${label}-error`)
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    await context.close()
  }
}

async function navigateToOAuth(
  page: Page,
  handle: string,
  label: string,
  baseUrl: string,
) {
  info(`${label}: Navigating to OAuth authorize...`)
  const authorizeUrl = `${baseUrl}/oauth/authorize?handle=${encodeURIComponent(
    handle,
  )}`

  // Stratos will redirect to the PDS OAuth page — may take a moment
  await page.goto(authorizeUrl, { waitUntil: 'load', timeout: 30_000 })

  dim(`${label}: Current URL: ${page.url()}`)
  await screenshot(page, `${label}-01-after-redirect`)

  const content = await page.content()
  if (content.toLowerCase().includes('failed to resolve identity')) {
    error(`${label}: Page contains 'Failed to resolve identity' error`, {
      error: page.url(),
    })
    throw new Error('Failed to resolve identity')
  }
}

async function verifyEnrollmentResponse(
  page: Page,
  label: string,
): Promise<{ success: boolean; did?: string; error?: string }> {
  await page.waitForTimeout(1_000)

  // textContent waits for its selector and throws when it never appears,
  // so the body fallback needs a catch, not a null-coalesce.
  const bodyText = await page
    .textContent('pre', { timeout: 2_000 })
    .catch(() => page.textContent('body'))
  dim(`${label}: Response body: ${bodyText?.substring(0, 200)}`)

  if (!bodyText) {
    await screenshot(page, `${label}-05-bad-response`)
    return { success: false, error: 'Callback returned an empty page' }
  }

  let json: {
    success?: boolean
    did?: string
    error?: string
    message?: string
  }
  try {
    json = JSON.parse(bodyText)
  } catch {
    await screenshot(page, `${label}-05-bad-response`)
    return {
      success: false,
      error: `Callback body is not JSON: ${bodyText.substring(0, 200)}`,
    }
  }

  if (json.success !== true || typeof json.did !== 'string') {
    await screenshot(page, `${label}-05-bad-response`)
    return {
      success: false,
      error: json.error
        ? `${json.error}: ${json.message ?? ''}`
        : `Callback did not report success: ${bodyText.substring(0, 200)}`,
    }
  }

  return { success: true, did: json.did }
}

async function checkEnrollmentStatus(did: string) {
  try {
    return await enrollmentStatus(did)
  } catch {
    return null
  }
}

/**
 * Look up the user's `zone.stratos.actor.enrollment` records on the PDS and
 * check whether one matches the rkey the status endpoint reported.
 */
async function findPdsEnrollmentRkey(
  did: string,
  expectedRkey: string,
): Promise<{ found: boolean; rkeys: string[] }> {
  try {
    const listing = await listPdsRecords(
      PDS_URL,
      did,
      'zone.stratos.actor.enrollment',
    )
    const rkeys = listing.records.map(
      (record) => record.uri.split('/').pop() ?? '',
    )
    return { found: rkeys.includes(expectedRkey), rkeys }
  } catch (err) {
    error(`PDS listRecords failed for ${did}`, {
      error: err instanceof Error ? err.message : String(err),
    })
    return { found: false, rkeys: [] }
  }
}

async function run() {
  section('Phase 2: OAuth Enrollment')

  const state = await loadState()
  if (Object.keys(state.users).length === 0) {
    fail('No users in state — run setup.ts first')
    Deno.exit(1)
  }

  info('Launching headless browser...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    for (const [key, userDef] of Object.entries(TEST_USERS)) {
      const userState = state.users[key]
      if (!userState) {
        fail(`No state for user ${key} — skipping`)
        continue
      }

      const status = await checkEnrollmentStatus(userState.did)
      // `enrolled: true` now means an enrollment row exists (eligible-only
      // DIDs report `enrolled: false, eligible: true`). Requiring
      // enrollmentRkey too keeps the skip robust against older servers.
      if (status?.enrolled && status.enrollmentRkey) {
        // A service row alone does not prove the enrollment. Check the PDS
        // record before we skip OAuth. A stale row would otherwise hide a
        // missing record, and this phase would report a pass it never checked.
        const existing = await findPdsEnrollmentRkey(
          userState.did,
          status.enrollmentRkey,
        )
        if (existing.found) {
          pass(
            `${userDef.name} already enrolled — OAuth skipped`,
            userState.did,
          )
          userState.enrolled = true
          continue
        }
        info(
          `${userDef.name} reports enrolled but the PDS record is missing — enrolling again`,
        )
      }

      info(`Enrolling ${userDef.name} (${userState.handle})...`)
      const result = await enrollUser(
        browser,
        userState.handle,
        userState.password,
        key,
      )

      if (!result.success) {
        fail(`${userDef.name} enrollment failed`, result.error)
        continue
      }

      if (result.did !== userState.did) {
        fail(
          `${userDef.name} callback DID mismatch`,
          `expected ${userState.did}, got ${result.did}`,
        )
        continue
      }

      const finalStatus = await checkEnrollmentStatus(userState.did)
      // Require the enrollment record rkey — see the skip check above.
      if (!finalStatus?.enrolled || !finalStatus.enrollmentRkey) {
        fail(
          `${userDef.name} enrollment — OAuth succeeded but no enrollment record`,
          `enrolled=${finalStatus?.enrolled ?? 'unknown'}, rkey=${
            finalStatus?.enrollmentRkey ?? 'none'
          }`,
        )
        continue
      }

      // Verify the real side effect in this phase: the enrollment record must
      // exist on the user's PDS with the rkey the status endpoint reported.
      const pdsRkey = await findPdsEnrollmentRkey(
        userState.did,
        finalStatus.enrollmentRkey,
      )
      if (!pdsRkey.found) {
        fail(
          `${userDef.name} enrollment — no matching PDS enrollment record`,
          `expected rkey=${finalStatus.enrollmentRkey}, PDS has [${pdsRkey.rkeys.join(', ')}]`,
        )
        continue
      }

      userState.enrolled = true
      pass(`${userDef.name} enrolled successfully`, userState.did)
    }
  } finally {
    await browser.close()
  }

  await saveState(state)

  if (failureCount() > 0) {
    info('Check test-data/screenshots/ for debugging screenshots')
  }
  finish()
}

run().catch((err) => {
  console.error('\nEnrollment test failed:', err)
  Deno.exit(1)
})
