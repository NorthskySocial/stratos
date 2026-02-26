#!/usr/bin/env -S deno run -A
import { chromium, type Browser, type Page } from 'npm:playwright@1.58.2'
import { STRATOS_URL } from './lib/config.ts'
import { loadState } from './lib/state.ts'
import { section, info, pass, fail, dim, summary } from './lib/log.ts'

const SCREENSHOT_DIR = new URL('../test-data/screenshots', import.meta.url)
  .pathname

async function screenshot(page: Page, name: string) {
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

async function getAuthorizeUrl(handle: string) {
  const state = await loadState()
  const baseUrl = state.ngrokUrl || STRATOS_URL
  return `${baseUrl}/oauth/authorize?handle=${encodeURIComponent(handle)}`
}

async function testInvalidPassword() {
  section('OAuth Login: Invalid Password Test')

  const state = await loadState()
  const rei = state.users.rei

  if (!rei) {
    fail('Missing user state (rei) — run setup.ts first')
    Deno.exit(1)
  }

  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()

  let passed = 0
  let failed = 0

  try {
    info(`Attempting login for ${rei.handle} with INVALID password...`)
    const authorizeUrl = await getAuthorizeUrl(rei.handle)

    // Set a custom header to skip ngrok browser warning
    await context.setExtraHTTPHeaders({
      'ngrok-skip-browser-warning': 'true',
    })

    await page.goto(authorizeUrl, { waitUntil: 'load', timeout: 30_000 })
    dim(`Current URL: ${page.url()}`)
    await screenshot(page, 'auth-fail-01-after-redirect')

    // Handle ngrok interstitial if it exists
    const ngrokButton = await page.$(
      'button:has-text("Visit Site"), button:has-text("Visit the site")',
    )
    if (ngrokButton || page.url().includes('ngrok-free.app')) {
      if (ngrokButton) {
        await ngrokButton.click()
        try {
          await page.waitForNavigation({
            waitUntil: 'networkidle',
            timeout: 15_000,
          })
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (error) {
          fail('Failed to navigate to PDS after ngrok click')
        }
      }
    }

    // Wait for password field
    await page.waitForSelector('input[type="password"]', { timeout: 15_000 })

    // Fill correct handle if username input exists and is empty
    const usernameInput = await page.$(
      'input[name="username"], input[name="identifier"]',
    )
    if (usernameInput) {
      const val = await usernameInput.inputValue()
      if (!val) {
        await usernameInput.fill(rei.handle)
      }
    }

    // Fill INVALID password
    await page.fill('input[type="password"]', 'totally-wrong-password-12345')

    dim('Submitting with invalid password...')
    await page.keyboard.press('Enter')

    // Wait for error message to appear on the PDS login page.
    // The PDS pre-renders the error <dd> in a hidden state and reveals it after
    // a failed login. Playwright's default visibility check may not detect the
    // reveal (e.g. CSS animation, attribute toggle), so we first wait for the
    // element to be attached, then check its text content directly.
    const errorSelector =
      'text=/Invalid username or password|Authentication failed|Invalid identifier or password/i'
    try {
      await page.waitForSelector(errorSelector, {
        timeout: 10_000,
        state: 'attached',
      })
      const errorEl = await page.$(errorSelector)
      const errorText = errorEl ? await errorEl.textContent() : null
      await screenshot(page, 'auth-fail-02-error-displayed')
      pass(
        'PDS displayed error message for invalid password',
        errorText ?? undefined,
      )
      passed++
    } catch (err) {
      await screenshot(page, 'auth-fail-02-timeout-no-error')
      if (err instanceof Error) {
        dim(err.message)
      }
      fail(
        'PDS did not display expected error message for invalid password within timeout',
      )
      failed++
    }
  } catch (err) {
    await screenshot(page, 'auth-fail-unexpected-error')
    fail('Test failed with error', String(err))
    failed++
  } finally {
    await browser.close()
  }

  summary(passed, failed)
  if (failed > 0) Deno.exit(1)
}

testInvalidPassword()
