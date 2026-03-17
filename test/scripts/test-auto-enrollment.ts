#!/usr/bin/env -S deno run -A
import { chromium, type Browser } from 'npm:playwright@1.58.2'
import { STRATOS_URL, PDS_URL } from './lib/config.ts'
import { loadState } from './lib/state.ts'
import { section, info, pass, fail, error } from './lib/log.ts'
import { waitForHealthy } from './lib/stratos.ts'
import { createSession } from './lib/pds.ts'

const PROJECT_ROOT = new URL('../../', import.meta.url).pathname

async function restartStratosWithAutoEnroll(domains: string) {
  info(`Restarting Stratos with STRATOS_AUTO_ENROLL_DOMAINS=${domains}...`)

  const state = await loadState()
  const envVars: Record<string, string> = {
    STRATOS_AUTO_ENROLL_DOMAINS: domains,
    STRATOS_ENROLLMENT_mode: ENROLLMENT_MODE.OPEN, // Ensure we can enroll
  }

  if (state.ngrokUrl) {
    envVars['STRATOS_PUBLIC_URL'] = state.ngrokUrl
    envVars['STRATOS_SERVICE_DID'] =
      `did:web:${state.ngrokUrl.replace(/^https?:\/\//, '')}`
    envVars['STRATOS_OAUTH_CLIENT_ID'] =
      `${state.ngrokUrl}/client-metadata.json`
    envVars['STRATOS_OAUTH_CLIENT_URI'] = state.ngrokUrl
    envVars['STRATOS_OAUTH_REDIRECT_URI'] = `${state.ngrokUrl}/oauth/callback`
  } else {
    envVars['STRATOS_PUBLIC_URL'] = 'http://127.0.0.1:3100'
    envVars['STRATOS_SERVICE_DID'] = 'did:web:127.0.0.1%3A3100'
    envVars['STRATOS_OAUTH_CLIENT_ID'] =
      'http://127.0.0.1:3100/client-metadata.json'
    envVars['STRATOS_OAUTH_CLIENT_URI'] = 'http://127.0.0.1:3100'
    envVars['STRATOS_OAUTH_REDIRECT_URI'] =
      'http://127.0.0.1:3100/oauth/callback'
  }

  const compose = new Deno.Command('docker-compose', {
    args: [
      '-f',
      'docker-compose.test.yml',
      'up',
      '-d',
      '--force-recreate',
      'stratos',
    ],
    cwd: PROJECT_ROOT,
    env: {
      ...Deno.env.toObject(),
      ...envVars,
    },
  })

  const result = await compose.output()
  if (!result.success) {
    throw new Error(
      `Failed to restart Stratos: ${new TextDecoder().decode(result.stderr)}`,
    )
  }

  await waitForHealthy()
}

async function enrollUser(
  browser: Browser,
  handle: string,
  password: string,
  label: string,
) {
  const state = await loadState()
  const baseUrl = state.ngrokUrl || STRATOS_URL
  const authorizeUrl = `${baseUrl}/oauth/authorize?handle=${encodeURIComponent(handle)}`

  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()

  try {
    info(`${label}: Navigating to ${authorizeUrl}`)
    await page.goto(authorizeUrl)

    // Handle ngrok interstitial if it exists
    const ngrokButton = await page.$(
      'button:has-text("Visit Site"), button:has-text("Visit the site")',
    )
    if (ngrokButton) {
      await ngrokButton.click()
      await page.waitForNavigation({ waitUntil: 'networkidle' })
    }

    // Sign in to PDS
    await page.waitForSelector('input[type="password"]')
    const usernameInput = await page.$(
      'input[name="username"], input[name="identifier"]',
    )
    if (usernameInput && !(await usernameInput.isDisabled())) {
      await usernameInput.fill(handle)
    }
    await page.fill('input[type="password"]', password)
    await page.click('button[type="submit"], button:has-text("Sign in")')

    // Wait for consent or callback
    await page.waitForURL(
      (url: { toString: () => string | string[] }) =>
        url.toString().includes('authorize') ||
        url.toString().includes('consent') ||
        url.toString().includes('/oauth/callback'),
    )

    if (!page.url().includes('/oauth/callback')) {
      const acceptButton = await page.$(
        'button:has-text("Accept"), button:has-text("Authorize"), button:has-text("Allow")',
      )
      if (acceptButton) {
        await acceptButton.click()
      } else {
        await page.keyboard.press('Enter')
      }
      await page.waitForURL((url: { toString: () => string | string[] }) =>
        url.toString().includes('/oauth/callback'),
      )
    }

    const bodyText = await page.textContent('body')
    if (!bodyText?.includes('"success":true')) {
      throw new Error(`Enrollment failed: ${bodyText}`)
    }
    pass(`${label}: Enrolled successfully`)
  } finally {
    await context.close()
  }
}

async function verifyEnrollmentStatus(
  did: string,
  expectedBoundaries: string[],
) {
  const state = await loadState()
  const baseUrl = state.ngrokUrl || STRATOS_URL

  info(`Verifying enrollment status for ${did}...`)
  const res = await fetch(`${baseUrl}/oauth/status`, {
    headers: {
      Authorization: `Bearer ${did}`,
    },
  })

  if (!res.ok) {
    throw new Error(`Status check failed: ${res.status} ${await res.text()}`)
  }

  const data = await res.json()
  info(`Status response: ${JSON.stringify(data)}`)

  const actualBoundaries = data.boundaries || []
  const match =
    expectedBoundaries.length === actualBoundaries.length &&
    expectedBoundaries.every((b) => actualBoundaries.includes(b))

  if (match) {
    pass(`Boundaries match expected: ${expectedBoundaries.join(', ')}`)
  } else {
    fail(
      `Boundaries mismatch. Expected: [${expectedBoundaries}], Got: [${actualBoundaries}]`,
    )
    throw new Error('Boundary mismatch')
  }
}

async function verifyPdsRecord(
  handle: string,
  password: string,
  expectedBoundaries: string[],
) {
  info(`Verifying PDS record for ${handle}...`)
  const session = await createSession(handle, password)
  const did = session.did

  const res = await fetch(
    `${PDS_URL}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=zone.stratos.actor.enrollment&rkey=self`,
    {
      headers: {
        Authorization: `Bearer ${session.accessJwt}`,
      },
    },
  )

  if (!res.ok) {
    throw new Error(
      `Failed to get PDS record: ${res.status} ${await res.text()}`,
    )
  }

  const data = await res.json()
  info(`PDS record: ${JSON.stringify(data.value)}`)

  const recordBoundaries = data.value.boundaries.map(
    //eslint-disable-next-line @typescript-eslint/no-explicit-any
    (b: { value: any }) => b.value,
  )
  const match =
    expectedBoundaries.length === recordBoundaries.length &&
    expectedBoundaries.every((b) => recordBoundaries.includes(b))

  if (match) {
    pass(
      `PDS record boundaries match expected: ${expectedBoundaries.join(', ')}`,
    )
  } else {
    fail(
      `PDS record boundaries mismatch. Expected: [${expectedBoundaries}], Got: [${recordBoundaries}]`,
    )
    throw new Error('PDS record boundary mismatch')
  }
}

async function run() {
  section('Auto-Enrollment Test')

  const state = await loadState()
  const testUserKey = 'Rei'
  const user = state.users[testUserKey]
  if (!user) {
    fail('Test user Rei not found in state. Run setup.ts first.')
    Deno.exit(1)
  }

  // Use a unique set of domains for this test
  const testDomains = ['auto-domain-1', 'auto-domain-2']
  const testDomainsStr = testDomains.join(',')

  try {
    await restartStratosWithAutoEnroll(testDomainsStr)

    info('Launching browser...')
    const browser = await chromium.launch({ headless: true })

    try {
      // We need to make sure the user is NOT enrolled first, or use a new user.
      // For simplicity in this test environment, we'll assume we can re-enroll
      // if we force-recreate the container (which uses a fresh sqlite db if not volumed,
      // but it IS volumed in docker-compose.test.yml).
      // Actually, the volume is 'stratos-data'.

      info(`Enrolling user ${user.handle}...`)
      await enrollUser(browser, user.handle, user.password, testUserKey)

      await verifyEnrollmentStatus(user.did, testDomains)
      await verifyPdsRecord(user.handle, user.password, testDomains)
    } finally {
      await browser.close()
    }

    pass('Auto-enrollment test passed')
  } catch (err) {
    error('Auto-enrollment test failed', { error: String(err) })
    Deno.exit(1)
  }
}

run()
