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
import { dim, error, fail, info, pass, section, warn } from './lib/log.ts'

const SCREENSHOT_DIR = new URL('../test-data/screenshots', import.meta.url)
  .pathname

async function screenshotOnFailure(page: Page, name: string) {
  try {
    await Deno.mkdir(SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/${name}.png`,
      fullPage: true,
    })
    dim(`Screenshot saved: test-data/screenshots/${name}.png`)
  } catch {
    // best effort
    dim(`Failed to save screenshot: ${name}.png`)
  }
}

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
async function getAuthorizeUrl(handle: string) {
  const state = await loadState()
  const baseUrl = state.ngrokUrl || STRATOS_URL
  return `${baseUrl}/oauth/authorize?handle=${encodeURIComponent(handle)}`
}

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
    await navigateToOAuth(page, context, handle, label)
    await handleNgrokInterstitial(page, label)
    await fillSignInForm(page, handle, password, label)
    await submitSignInAndConsent(page, label)
    return await verifyEnrollmentResponse(page, label)
  } catch (err) {
    await screenshotOnFailure(page, `${label}-error`)
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
) {
  info(`${label}: Navigating to OAuth authorize...`)
  const authorizeUrl = await getAuthorizeUrl(handle)

  // Set a custom header to skip ngrok browser warning
  await context.setExtraHTTPHeaders({
    'ngrok-skip-browser-warning': 'true',
  })

  // Stratos will redirect to the PDS OAuth page — may take a moment
  await page.goto(authorizeUrl, { waitUntil: 'load', timeout: 30_000 })

  dim(`${label}: Current URL: ${page.url()}`)
  await screenshotOnFailure(page, `${label}-01-after-redirect`)

  const content = await page.content()
  if (content.toLowerCase().includes('failed to resolve identity')) {
    error(`${label}: Page contains 'Failed to resolve identity' error`)
    throw new Error('Failed to resolve identity')
  }
}

async function handleNgrokInterstitial(page: Page, label: string) {
  const ngrokButton = await page.$(
    'button:has-text("Visit Site"), button:has-text("Visit the site")',
  )
  if (!ngrokButton && !page.url().includes('ngrok-free.app')) {
    return
  }

  const body = await page.textContent('body')
  const isNgrokPage =
    body?.includes('ngrok') &&
    (body?.includes('browser') ||
      body?.includes('Visit') ||
      body?.includes('visit'))

  if (!isNgrokPage) {
    return
  }

  dim(`${label}: Ngrok interstitial detected, searching for Visit button...`)
  if (ngrokButton) {
    await ngrokButton.click()
  } else {
    const buttons = await page.$$('button')
    if (buttons.length > 0) {
      await buttons[0].click()
    } else {
      await page.click('text=/Visit Site/i').catch(() => {})
    }
  }

  try {
    await page.waitForNavigation({
      waitUntil: 'networkidle',
      timeout: 30_000,
    })
  } catch {
    dim(
      `${label}: Navigation after ngrok click timed out or didn't happen, continuing...`,
    )
  }
  dim(`${label}: After ngrok interstitial URL: ${page.url()}`)
  await screenshotOnFailure(page, `${label}-01b-after-ngrok`)
}

async function fillSignInForm(
  page: Page,
  handle: string,
  password: string,
  label: string,
) {
  await page.waitForSelector('input[name="password"], input[type="password"]', {
    timeout: 15_000,
  })

  dim(`${label}: Sign-in form detected`)

  const usernameInput =
    (await page.$('input[name="username"]:not([readonly]):not([disabled])')) ??
    (await page.$('input[name="identifier"]:not([readonly]):not([disabled])'))
  if (usernameInput) {
    info(`${label}: Username field found, filling handle...`)
    await usernameInput.fill(handle)
  }

  const passwordInput =
    (await page.$('input[name="password"]')) ??
    (await page.$('input[type="password"]'))
  if (!passwordInput) {
    throw new Error('Could not find password input on sign-in page')
  }
  await passwordInput.fill(password)
}

async function submitSignInAndConsent(page: Page, label: string) {
  dim(`${label}: Credentials entered, submitting...`)
  await screenshotOnFailure(page, `${label}-02-credentials-filled`)

  const signInButton =
    (await page.$('button[type="submit"]')) ??
    (await page.$('button:has-text("Sign in")'))

  if (signInButton) {
    await signInButton.click()
  } else {
    await page.keyboard.press('Enter')
  }

  await page.waitForURL(
    (url: URL) => {
      const s = url.toString()
      return (
        s.includes('/oauth/callback') ||
        s.includes('authorize') ||
        s.includes('consent')
      )
    },
    { timeout: 15_000 },
  )

  dim(`${label}: After sign-in URL: ${page.url()}`)
  await screenshotOnFailure(page, `${label}-03-after-signin`)

  if (!page.url().includes('/oauth/callback')) {
    await page.waitForTimeout(1_000)

    const acceptButton =
      (await page.$('button:has-text("Accept")')) ??
      (await page.$('button:has-text("Authorize")')) ??
      (await page.$('button:has-text("Allow")')) ??
      (await page.$('button[type="submit"]'))

    if (acceptButton) {
      dim(`${label}: Clicking authorize/accept button...`)
      await acceptButton.click()
    } else {
      warn(`${label}: No authorize button found, trying submit...`)
      await page.keyboard.press('Enter')
    }

    const state = await loadState()
    const baseUrl = state.ngrokUrl || STRATOS_URL
    await page.waitForURL((url: URL) => url.toString().includes(baseUrl), {
      timeout: 15_000,
    })
  }

  dim(`${label}: Final URL: ${page.url()}`)
  await screenshotOnFailure(page, `${label}-04-final`)
}

async function verifyEnrollmentResponse(
  page: Page,
  label: string,
): Promise<{ success: boolean; did?: string }> {
  await page.waitForTimeout(1_000)

  const bodyText = await page.textContent('body')
  dim(`${label}: Response body: ${bodyText?.substring(0, 200)}`)

  if (
    bodyText?.includes('"success":true') ||
    bodyText?.includes('"enrolled"')
  ) {
    try {
      const preText = (await page.textContent('pre')) ?? bodyText
      const json = JSON.parse(preText!)
      return { success: true, did: json.did }
    } catch {
      return { success: true }
    }
  }

  return { success: true }
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

  let passed = 0
  let failed = 0

  try {
    for (const [key, userDef] of Object.entries(TEST_USERS)) {
      const userState = state.users[key]
      if (!userState) {
        fail(`No state for user ${key} — skipping`)
        failed++
        continue
      }

      const status = await checkEnrollmentStatus(userState.did)
      if (status?.enrolled) {
        warn(`${userDef.name} (${userState.did}) already enrolled — skipping`)
        userState.enrolled = true
        passed++
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
        failed++
        continue
      }

      const finalStatus = await checkEnrollmentStatus(userState.did)
      if (finalStatus?.enrolled) {
        userState.enrolled = true
        pass(`${userDef.name} enrolled successfully`, userState.did)
        passed++
      } else {
        fail(
          `${userDef.name} enrollment — OAuth succeeded but status shows not enrolled`,
        )
        failed++
      }
    }
  } finally {
    await browser.close()
  }

  await saveState(state)

  section('Enrollment Summary')
  info(`${passed} enrolled, ${failed} failed`)

  if (failed > 0) {
    info('Check test-data/screenshots/ for debugging screenshots')
    Deno.exit(1)
  }
}

run().catch((err) => {
  console.error('\nEnrollment test failed:', err)
  Deno.exit(1)
})
