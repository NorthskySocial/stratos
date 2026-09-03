// Admin OAuth login via a headless browser. Split from admin.ts so phases
// that only reuse a stored session cookie do not load Playwright.

import type { Browser, Page } from 'npm:playwright@1.58.2'
import { STRATOS_URL } from './config.ts'
import { dim, fail, info } from './log.ts'
import { ADMIN_SESSION_COOKIE } from './admin.ts'

const SCREENSHOT_DIR = new URL('../../test-data/screenshots', import.meta.url)
  .pathname

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

/**
 * Drive the admin OAuth flow for the operator and return the opaque admin
 * session cookie value. Mirrors the enrollment OAuth flow but targets the admin
 * authorize/callback routes; the cookie is set on the callback response, so it
 * is present in the browser context even though /admin itself has no page yet.
 */
export async function adminLogin(
  browser: Browser,
  handle: string,
  password: string,
): Promise<string | null> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()

  try {
    const authorizeUrl = `${STRATOS_URL}/admin/oauth/authorize?handle=${encodeURIComponent(
      handle,
    )}`
    info(
      `Operator: starting admin OAuth at ${STRATOS_URL}/admin/oauth/authorize`,
    )
    await page.goto(authorizeUrl, { waitUntil: 'load', timeout: 30_000 })

    await page.waitForSelector(
      'input[type="password"], input[name="password"]',
      {
        timeout: 15_000,
      },
    )
    const usernameInput =
      (await page.$(
        'input[name="username"]:not([readonly]):not([disabled])',
      )) ??
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
        return (
          s.includes('/admin') ||
          s.includes('authorize') ||
          s.includes('consent')
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
      await page
        .waitForURL((url: URL) => url.toString().includes(STRATOS_URL), {
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
    fail(
      'Admin OAuth login threw',
      err instanceof Error ? err.message : String(err),
    )
    return null
  } finally {
    await context.close()
  }
}
