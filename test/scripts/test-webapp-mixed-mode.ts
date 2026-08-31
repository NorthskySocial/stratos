#!/usr/bin/env -S deno run -A

import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from 'npm:playwright@1.58.2'
import { adminSetBoundaries } from './lib/admin.ts'
import { DOMAINS, PDS_URL, SPACES, TEST_ROOT } from './lib/config.ts'
import { assert, fail, finish, info, section } from './lib/log.ts'
import {
  createPdsSession,
  getPdsSpaceRecord,
  parseSpaceRecordUri,
  SPACE_POST_COLLECTION,
} from './lib/mixed-mode-pds.ts'
import {
  fillSignInForm,
  handleNgrokInterstitial,
  screenshot,
  submitSignInAndConsent,
} from './lib/oauth-flow.ts'
import { loadState, type TestState, type UserState } from './lib/state.ts'
import { listPdsRecords, tryGetRecord } from './lib/stratos.ts'

const WEBAPP_URL = 'http://127.0.0.1:5173'
const PDS_WEBAPP_URL = 'http://127.0.0.1:5174'
const FEEDGEN_URL = 'http://127.0.0.1:3302'
const FEEDGEN_DID = 'did:web:localhost%3A3302'
const PDS_PROXY_PATH_PREFIX = '/pds'
const SPACE_CREATE_PATH = '/xrpc/com.atproto.space.createRecord'
const REPO_CREATE_PATH = '/xrpc/com.atproto.repo.createRecord'
const PUBLIC_COLLECTION = 'app.bsky.feed.post'

interface RecordResponse {
  uri: string
  cid: string
}

interface CapturedWrite {
  readonly path: string
  readonly url: string
  readonly body: Record<string, unknown>
}

function requireValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Missing ${name} in E2E state`)
  return value
}

function xrpcPath(rawUrl: string): string {
  const pathname = new URL(rawUrl).pathname
  return pathname.startsWith(`${PDS_PROXY_PATH_PREFIX}/`)
    ? pathname.slice(PDS_PROXY_PATH_PREFIX.length)
    : pathname
}

function captureWrites(page: Page): CapturedWrite[] {
  const writes: CapturedWrite[] = []
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    const path = xrpcPath(request.url())
    if (path !== SPACE_CREATE_PATH && path !== REPO_CREATE_PATH) {
      return
    }
    const rawBody = request.postData()
    if (!rawBody) return
    try {
      writes.push({
        path,
        url: request.url(),
        body: JSON.parse(rawBody) as Record<string, unknown>,
      })
    } catch {
      // The contract assertions below reject an absent JSON write.
    }
  })
  return writes
}

function isWebappUrl(rawUrl: string, webappUrl: string): boolean {
  const url = new URL(rawUrl)
  return url.origin === webappUrl && url.pathname === '/'
}

async function login(
  page: Page,
  user: UserState,
  expectedCustody: 'PDS' | 'Stratos service',
  label: string,
  webappUrl = WEBAPP_URL,
  identifier = user.did,
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await page.goto(webappUrl, { waitUntil: 'domcontentloaded' })
    const identifierInput = page.getByPlaceholder(
      'Enter your handle (e.g. alice.bsky.social)',
    )
    await identifierInput.waitFor({ state: 'visible', timeout: 15_000 })
    await identifierInput.fill(identifier)
    await page.getByRole('button', { name: 'Sign In' }).click()
    await handleNgrokInterstitial(page, label)
    try {
      await fillSignInForm(page, user.handle, user.password, label)
      break
    } catch (error) {
      if (attempt === 2) {
        await screenshot(page, `${label}-sign-in-failed`)
        info(`${label}: OAuth sign-in did not load at ${page.url()}`)
        throw error
      }
      info(`${label}: Retrying OAuth after the browser network changed`)
    }
  }
  await submitSignInAndConsent(page, label, (url) =>
    isWebappUrl(url, webappUrl),
  )
  await page.waitForSelector('.composer', { timeout: 30_000 })
  await page
    .locator('.custody-status')
    .filter({ hasText: expectedCustody })
    .waitFor({ state: 'visible', timeout: 30_000 })
  assert(
    (await page.locator('.custody-status').textContent())?.includes(
      expectedCustody,
    ) === true,
    `${label} displays ${expectedCustody} custody`,
  )
}

async function waitForPrivateComposer(page: Page): Promise<void> {
  const privateToggle = page.locator('.private-toggle input')
  const ready = await waitUntil(
    async () =>
      (await privateToggle.isEnabled()) && (await privateToggle.isChecked()),
    30_000,
  )
  if (!ready) throw new Error('Private Composer mode did not become available')
  await page.selectOption('.domain-select', { value: DOMAINS.swordsmith })
}

async function createPrivatePost(
  page: Page,
  endpoint: string,
  text: string,
): Promise<RecordResponse> {
  await waitForPrivateComposer(page)
  await page.locator('.composer textarea').fill(text)
  const responsePromise = page.waitForResponse(
    (response) => {
      return (
        response.request().method() === 'POST' &&
        xrpcPath(response.url()) === endpoint &&
        response.ok()
      )
    },
    { timeout: 45_000 },
  )
  await page.locator('.composer-actions > button').click()
  const response = await responsePromise
  const body = (await response.json()) as Partial<RecordResponse>
  if (typeof body.uri !== 'string' || typeof body.cid !== 'string') {
    throw new Error(`${endpoint} returned no record reference`)
  }
  const cleared = await waitUntil(
    async () => (await page.locator('.composer textarea').inputValue()) === '',
    15_000,
  )
  if (!cleared)
    throw new Error('Composer did not clear after the private write')
  return { uri: body.uri, cid: body.cid }
}

function findWrite(
  writes: CapturedWrite[],
  endpoint: string,
  text: string,
): CapturedWrite | undefined {
  return writes.find((write) => {
    if (write.path !== endpoint) return false
    const record = write.body['record'] as Record<string, unknown> | undefined
    return record?.['text'] === text
  })
}

function publicWriteCount(writes: CapturedWrite[]): number {
  return writes.filter(
    (write) => write.body['collection'] === PUBLIC_COLLECTION,
  ).length
}

function assertPdsWrite(
  write: CapturedWrite | undefined,
  member: UserState,
): void {
  const record = write?.body['record'] as Record<string, unknown> | undefined
  assert(
    write?.url.startsWith(`${PDS_WEBAPP_URL}${PDS_PROXY_PATH_PREFIX}/`) ===
      true &&
      write.body['space'] === SPACES.swordsmith &&
      write.body['repo'] === member.did &&
      write.body['collection'] === SPACE_POST_COLLECTION &&
      write.body['validate'] === false &&
      record?.['$type'] === SPACE_POST_COLLECTION &&
      record !== undefined &&
      !('boundary' in record) &&
      !('embed' in record),
    'Composer sends the exact PDS-custody space write contract',
  )
}

function assertStratosWrite(
  write: CapturedWrite | undefined,
  user: UserState,
  stratosUrl: string,
): void {
  const record = write?.body['record'] as Record<string, unknown> | undefined
  const boundary = record?.['boundary'] as
    | { values?: Array<{ value?: string }> }
    | undefined
  assert(
    write?.url.startsWith(stratosUrl) === true &&
      write.body['repo'] === user.did &&
      write.body['collection'] === SPACE_POST_COLLECTION &&
      record?.['$type'] === SPACE_POST_COLLECTION &&
      boundary?.values?.some((entry) => entry.value === DOMAINS.swordsmith) ===
        true,
    'Composer sends the exact Stratos-custody record contract',
  )
}

async function assertPdsResidency(
  member: UserState,
  ref: RecordResponse,
  text: string,
): Promise<void> {
  const path = parseSpaceRecordUri(ref.uri, SPACES.swordsmith)
  const session = await createPdsSession(member.handle, member.password)
  const stored = await getPdsSpaceRecord(
    session,
    SPACES.swordsmith,
    member.did,
    SPACE_POST_COLLECTION,
    path.rkey,
  )
  assert(
    stored.uri === ref.uri &&
      stored.cid === ref.cid &&
      stored.value['text'] === text,
    'The browser PDS-custody post resides in the spaces PDS',
  )
  const stratosRead = await tryGetRecord(
    member.did,
    SPACE_POST_COLLECTION,
    path.rkey,
    member.did,
  )
  assert(
    !stratosRead.ok,
    'The browser PDS-custody post is absent from Stratos storage',
    stratosRead.ok ? 'unexpected record' : `status=${stratosRead.status}`,
  )
}

function parseStratosRkey(uri: string, did: string): string {
  const prefix = `at://${did}/${SPACE_POST_COLLECTION}/`
  if (!uri.startsWith(prefix)) {
    throw new Error(`Unexpected Stratos record URI: ${uri}`)
  }
  const rkey = uri.slice(prefix.length)
  if (!rkey || rkey.includes('/')) {
    throw new Error(`Invalid Stratos record URI: ${uri}`)
  }
  return rkey
}

async function assertStratosResidency(
  user: UserState,
  ref: RecordResponse,
  text: string,
): Promise<void> {
  const rkey = parseStratosRkey(ref.uri, user.did)
  const stored = await tryGetRecord(
    user.did,
    SPACE_POST_COLLECTION,
    rkey,
    user.did,
  )
  assert(
    stored.ok && stored.data.value['text'] === text,
    'The browser Stratos-custody post resides in Stratos storage',
  )
  const pdsRecords = await listPdsRecords(
    PDS_URL,
    user.did,
    SPACE_POST_COLLECTION,
  )
  assert(
    !pdsRecords.records.some((record) => record.uri === ref.uri),
    'The browser Stratos-custody post is absent from the user PDS',
  )
}

async function assertPrivateFailureDoesNotPublish(
  page: Page,
  writes: CapturedWrite[],
): Promise<void> {
  const publicWritesBefore = publicWriteCount(writes)
  await page.route(`**${SPACE_CREATE_PATH}`, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'Unavailable',
        message: 'simulated failure',
      }),
    })
  })
  await waitForPrivateComposer(page)
  await page
    .locator('.composer textarea')
    .fill(`Motoko fail-closed probe ${Date.now()}`)
  await page.locator('.composer-actions > button').click()
  await page.locator('.composer .error').waitFor({
    state: 'visible',
    timeout: 15_000,
  })
  assert(
    publicWriteCount(writes) === publicWritesBefore,
    'A failed PDS private write never falls through to a public post',
  )
  await page.unroute(`**${SPACE_CREATE_PATH}`)
}

async function waitForRenderedPosts(
  page: Page,
  pdsText: string,
  stratosText: string,
): Promise<boolean> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.composer', { timeout: 30_000 })
    const pdsCard = page.locator('.post-card.private', { hasText: pdsText })
    const stratosCard = page.locator('.post-card.private', {
      hasText: stratosText,
    })
    if ((await pdsCard.count()) > 0 && (await stratosCard.count()) > 0) {
      for (const card of [pdsCard.first(), stratosCard.first()]) {
        if (
          (await card.locator('.private-badge').textContent()) !== 'Private' ||
          !(await card.locator('.domain-badge').allTextContents()).includes(
            'swordsmith',
          )
        ) {
          return false
        }
      }
      return true
    }
    await page.waitForTimeout(2_000)
  }
  return false
}

async function waitForHealth(
  url: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`)
      if (response.ok) return true
    } catch {
      // The container is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

function composeEnvironment(state: TestState): Record<string, string> {
  return {
    ...Deno.env.toObject(),
    STRATOS_PUBLIC_URL:
      state.ngrokUrl ?? Deno.env.get('STRATOS_URL') ?? 'http://127.0.0.1:3100',
    STRATOS_SERVICE_DID: state.serviceDid ?? 'did:web:127.0.0.1%3A3100',
  }
}

async function runBrowserCompose(
  state: TestState,
  command: string[],
  failureMessage: string,
): Promise<void> {
  const result = await new Deno.Command('docker-compose', {
    args: [
      '-f',
      'docker-compose.test.yml',
      '--profile',
      'browser-e2e',
      ...command,
    ],
    cwd: TEST_ROOT,
    env: composeEnvironment(state),
    stdout: 'inherit',
    stderr: 'piped',
  }).output()
  if (!result.success) {
    throw new Error(
      `${failureMessage}: ${new TextDecoder().decode(result.stderr)}`,
    )
  }
}

async function startBrowserServices(state: TestState): Promise<void> {
  await runBrowserCompose(
    state,
    ['rm', '-sf', 'feedgen-webapp'],
    'Browser feedgen reset failed',
  )
  await runBrowserCompose(
    state,
    [
      'up',
      '-d',
      '--build',
      '--no-deps',
      'feedgen-webapp',
      'webapp',
      'webapp-pds',
    ],
    'Browser services start failed',
  )
}

async function stopBrowserServices(state: TestState): Promise<void> {
  await runBrowserCompose(
    state,
    ['stop', 'feedgen-webapp', 'webapp', 'webapp-pds'],
    'Browser services stop failed',
  )
}

async function newContext(browser: Browser): Promise<BrowserContext> {
  return await browser.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'ngrok-skip-browser-warning': 'true' },
  })
}

async function run(): Promise<void> {
  section('Webapp: Browser Mixed Custody')
  const state = await loadState()
  const member = requireValue(state.mixedMode?.member, 'mixed-mode member')
  const stratosUser = requireValue(state.users['rei'], 'Rei user')
  const adminSessionCookie = requireValue(
    state.adminSessionCookie,
    'admin session cookie',
  )
  const stratosUrl = requireValue(state.ngrokUrl, 'ngrok URL')
  let browser: Browser | undefined
  let pdsContext: BrowserContext | undefined
  let stratosContext: BrowserContext | undefined

  try {
    info('Building and starting the browser E2E webapp and feedgen images')
    await startBrowserServices(state)
    assert(await waitForHealth(WEBAPP_URL), 'The production webapp is healthy')
    assert(
      await waitForHealth(PDS_WEBAPP_URL),
      'The PDS-resolver production webapp is healthy',
    )
    assert(
      await waitForHealth(FEEDGEN_URL),
      'The containerized feedgen is healthy',
    )

    const didDocument = (await fetch(
      `${FEEDGEN_URL}/.well-known/did.json`,
    ).then((response) => response.json())) as { id?: string }
    assert(
      didDocument.id === FEEDGEN_DID,
      'The browser feedgen publishes its resolvable service DID',
      didDocument.id,
    )

    const boundaryUpdate = await adminSetBoundaries(
      member.did,
      [DOMAINS.swordsmith],
      adminSessionCookie,
    )
    assert(
      boundaryUpdate.status === 200,
      'The browser phase restores the PDS member swordsmith boundary',
      `status=${boundaryUpdate.status}`,
    )
    if (boundaryUpdate.status !== 200) {
      throw new Error('Could not restore the PDS member boundary')
    }

    browser = await chromium.launch({ headless: true })
    pdsContext = await newContext(browser)
    const pdsPage = await pdsContext.newPage()
    const pdsWrites = captureWrites(pdsPage)
    await login(
      pdsPage,
      member,
      'PDS',
      'webapp-pds',
      PDS_WEBAPP_URL,
      member.handle,
    )

    const runId = Date.now()
    const pdsText = `Motoko browser PDS custody ${runId}`
    const pdsRef = await createPrivatePost(pdsPage, SPACE_CREATE_PATH, pdsText)
    assertPdsWrite(findWrite(pdsWrites, SPACE_CREATE_PATH, pdsText), member)
    assert(
      publicWriteCount(pdsWrites) === 0,
      'The PDS-custody browser write creates no public post',
    )
    await assertPdsResidency(member, pdsRef, pdsText)
    await assertPrivateFailureDoesNotPublish(pdsPage, pdsWrites)

    stratosContext = await newContext(browser)
    const stratosPage = await stratosContext.newPage()
    const stratosWrites = captureWrites(stratosPage)
    await login(
      stratosPage,
      stratosUser,
      'Stratos service',
      'webapp-stratos',
      WEBAPP_URL,
      stratosUser.handle,
    )
    const stratosText = `Rei browser Stratos custody ${runId}`
    const stratosRef = await createPrivatePost(
      stratosPage,
      REPO_CREATE_PATH,
      stratosText,
    )
    assertStratosWrite(
      findWrite(stratosWrites, REPO_CREATE_PATH, stratosText),
      stratosUser,
      stratosUrl,
    )
    assert(
      publicWriteCount(stratosWrites) === 0,
      'The Stratos-custody browser write creates no public post',
    )
    await assertStratosResidency(stratosUser, stratosRef, stratosText)

    assert(
      await waitForRenderedPosts(pdsPage, pdsText, stratosText),
      'The production webapp renders both browser-created custody classes together',
    )
    await screenshot(pdsPage, 'webapp-mixed-mode-rendered-feed')
  } catch (error) {
    fail(
      'Browser mixed-custody phase threw',
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    await Promise.allSettled([
      pdsContext?.close() ?? Promise.resolve(),
      stratosContext?.close() ?? Promise.resolve(),
    ])
    await browser?.close()
    try {
      await stopBrowserServices(state)
    } catch (error) {
      fail(
        'Browser services stopped',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  finish()
}

run().catch((error: unknown) => {
  console.error('\nWebapp mixed-mode phase failed:', error)
  Deno.exit(1)
})
