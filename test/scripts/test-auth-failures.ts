#!/usr/bin/env -S deno run -A
import { type Browser, chromium, type Page } from 'npm:playwright@1.58.2'
import { STRATOS_URL } from './lib/config.ts'
import { loadState } from './lib/state.ts'
import {
  fillSignInForm,
  handleNgrokInterstitial,
  screenshot,
} from './lib/oauth-flow.ts'
import {
  assert as assertTrue,
  dim,
  fail,
  finish,
  info,
  section,
  warn,
} from './lib/log.ts'

async function getAuthorizeUrl(handle: string) {
  const state = await loadState()
  const baseUrl = state.ngrokUrl || STRATOS_URL
  return `${baseUrl}/oauth/authorize?handle=${encodeURIComponent(handle)}`
}

async function verifyLoginRejected(page: Page) {
  // Soft signal: the PDS error wording is not ours to assert, so a missing
  // message only warns. The hard assertions below prove the Stratos outcome.
  const errorSelector =
    'text=/Invalid username or password|Authentication failed|Invalid identifier or password|Wrong identifier or password/i'
  try {
    await page.waitForSelector(errorSelector, {
      timeout: 10_000,
      state: 'attached',
    })
    const errorEl = await page.$(errorSelector)
    const errorText = errorEl ? await errorEl.textContent() : null
    await screenshot(page, 'auth-fail-02-error-displayed')
    dim(`PDS error message: ${errorText ?? '(no text)'}`)
  } catch {
    await screenshot(page, 'auth-fail-02-no-error-message')
    warn('PDS error message not found within timeout (wording may differ)')
  }

  // A rejected login keeps the sign-in form on screen. An accepted login
  // replaces it with the consent page, which has no password input.
  const passwordInput = await page.$('input[type="password"]')
  assertTrue(
    passwordInput !== null,
    'PDS did not accept the invalid password',
    `url=${page.url()}`,
  )

  const bodyText = (await page.textContent('body')) ?? ''
  assertTrue(
    !page.url().includes('/oauth/callback') &&
      !bodyText.includes('"success":true'),
    'OAuth flow did not reach the Stratos callback',
    `url=${page.url()}`,
  )
}

async function testStratosRejectsInvalidTokens() {
  section('Stratos XRPC: Invalid Token Rejection')

  const state = await loadState()
  const baseUrl = state.ngrokUrl || STRATOS_URL
  const url = `${baseUrl}/xrpc/com.atproto.repo.createRecord`
  const body = JSON.stringify({
    repo: 'did:plc:auth-failure-probe',
    collection: 'zone.stratos.feed.post',
    record: { $type: 'zone.stratos.feed.post', text: 'should never land' },
  })

  const noAuth = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  await noAuth.body?.cancel()
  assertTrue(
    noAuth.status === 401,
    'createRecord without Authorization header returns 401',
    `status=${noAuth.status}`,
  )

  const badBearer = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer not-a-did-token',
    },
    body,
  })
  await badBearer.body?.cancel()
  assertTrue(
    badBearer.status === 401,
    'createRecord with a non-DID bearer token returns 401',
    `status=${badBearer.status}`,
  )
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

  try {
    info(`Attempting login for ${rei.handle} with INVALID password...`)
    const authorizeUrl = await getAuthorizeUrl(rei.handle)

    await context.setExtraHTTPHeaders({
      'ngrok-skip-browser-warning': 'true',
    })

    await page.goto(authorizeUrl, { waitUntil: 'load', timeout: 30_000 })
    dim(`Current URL: ${page.url()}`)
    await screenshot(page, 'auth-fail-01-after-redirect')

    await handleNgrokInterstitial(page, 'auth-fail')
    await fillSignInForm(
      page,
      rei.handle,
      'totally-wrong-password-12345',
      'auth-fail',
    )
    dim('Submitting with invalid password...')
    await page.keyboard.press('Enter')

    await verifyLoginRejected(page)
  } catch (err) {
    await screenshot(page, 'auth-fail-unexpected-error')
    fail('Test failed with error', String(err))
  } finally {
    await browser.close()
  }

  await testStratosRejectsInvalidTokens()

  finish()
}

testInvalidPassword()
