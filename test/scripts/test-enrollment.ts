#!/usr/bin/env -S deno run -A
// Enrollment test — drives the PDS OAuth flow via Playwright to enroll each user.

import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from 'npm:playwright@1.58.2'
import { STRATOS_URL, TEST_USERS } from './lib/config.ts'
import { enrollmentStatus } from './lib/stratos.ts'
import { loadState, saveState } from './lib/state.ts'
import {
  fillSignInForm,
  handleNgrokInterstitial,
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
  const state = await loadState()
  const baseUrl = state.ngrokUrl || STRATOS_URL
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()

  try {
    await navigateToOAuth(page, context, handle, label, baseUrl)
    await handleNgrokInterstitial(page, label)
    await fillSignInForm(page, handle, password, label)
    await submitSignInAndConsent(page, label, (url) =>
      url.includes(`${baseUrl}/oauth/callback`),
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
  context: BrowserContext,
  handle: string,
  label: string,
  baseUrl: string,
) {
  info(`${label}: Navigating to OAuth authorize...`)
  const authorizeUrl = `${baseUrl}/oauth/authorize?handle=${encodeURIComponent(
    handle,
  )}`

  // Set a custom header to skip ngrok browser warning
  await context.setExtraHTTPHeaders({
    'ngrok-skip-browser-warning': 'true',
  })

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

  const bodyText =
    (await page.textContent('pre')) ?? (await page.textContent('body'))
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
      // `enrolled: true` alone is ambiguous — the status endpoint reports
      // eligible-but-not-yet-enrolled DIDs the same way (active: false, no
      // rkey). Only an existing enrollment record (enrollmentRkey present)
      // means OAuth has actually run and we can safely skip it.
      if (status?.enrolled && status.enrollmentRkey) {
        pass(`${userDef.name} already enrolled — OAuth skipped`, userState.did)
        userState.enrolled = true
        continue
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
      // Require the enrollment record rkey — `enrolled` alone also covers
      // eligible-but-not-enrolled DIDs (see the skip check above).
      if (finalStatus?.enrolled && finalStatus.enrollmentRkey) {
        userState.enrolled = true
        pass(`${userDef.name} enrolled successfully`, userState.did)
      } else {
        fail(
          `${userDef.name} enrollment — OAuth succeeded but no enrollment record`,
          `enrolled=${finalStatus?.enrolled ?? 'unknown'}, rkey=${
            finalStatus?.enrollmentRkey ?? 'none'
          }`,
        )
      }
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
