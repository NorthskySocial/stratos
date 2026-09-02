// Shared Playwright helpers that drive the PDS OAuth sign-in + consent flow.
// Used by the enrollment, auth-failure, and DPoP CRUD phases.

import type { Page } from 'npm:playwright@1.58.2'
import { dim, info, warn } from './log.ts'

const SCREENSHOT_DIR = new URL('../../test-data/screenshots', import.meta.url)
  .pathname

export async function screenshot(page: Page, name: string) {
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

export async function handleNgrokInterstitial(page: Page, label: string) {
  const ngrokButton = await page.$(
    'button:has-text("Visit Site"), button:has-text("Visit the site")',
  )
  const isNgrokFreeDomain = ['ngrok-free.app', 'ngrok-free.dev'].some(
    (domain) => page.url().includes(domain),
  )
  if (!ngrokButton && !isNgrokFreeDomain) {
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
  await screenshot(page, `${label}-01b-after-ngrok`)
}

export async function fillSignInForm(
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

/**
 * Submit the sign-in form, click through the consent page if one appears,
 * and wait until the browser lands on the caller's final URL.
 */
export async function submitSignInAndConsent(
  page: Page,
  label: string,
  isFinalUrl: (url: string) => boolean,
) {
  dim(`${label}: Credentials entered, submitting...`)
  await screenshot(page, `${label}-02-credentials-filled`)

  const signInButton =
    (await page.$('button[type="submit"]')) ??
    (await page.$('button:has-text("Sign in")'))

  if (signInButton) {
    await signInButton.click()
  } else {
    await page.keyboard.press('Enter')
  }

  const consentButton = page.locator(
    'button:has-text("Accept"), button:has-text("Authorize"), button:has-text("Allow")',
  )
  const signInError = page.getByText(/Wrong identifier or password/i)
  await Promise.race([
    page.waitForURL(
      (url: URL) => {
        const urlText = url.toString()
        return isFinalUrl(urlText) || urlText.includes('/oauth/callback')
      },
      { timeout: 15_000 },
    ),
    consentButton.waitFor({ state: 'visible', timeout: 15_000 }),
    signInError.waitFor({ state: 'visible', timeout: 15_000 }).then(() => {
      throw new Error('OAuth sign-in rejected the supplied credentials')
    }),
  ])

  dim(`${label}: After sign-in URL: ${page.url()}`)
  await screenshot(page, `${label}-03-after-signin`)

  if (!isFinalUrl(page.url())) {
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

    await page.waitForURL((url: URL) => isFinalUrl(url.toString()), {
      timeout: 15_000,
    })
  }

  dim(`${label}: Final URL: ${page.url()}`)
  await screenshot(page, `${label}-04-final`)
}
