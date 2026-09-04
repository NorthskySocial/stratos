#!/usr/bin/env -S deno run -A

/**
 * Smoke the deployed Clubhouse alpha with a real spaces-PDS account.
 *
 * This is intentionally separate from run-all.ts: it needs an operator-owned
 * credentials file and, when the supplied account is not already a room
 * member, writes a selected-room enrollment plus a disposable topic/reply.
 * Set CLUBHOUSE_PUBLIC_E2E_MUTATE=true to authorize those writes.
 */
import { chromium, type Locator, type Page } from 'npm:playwright@1.58.2'

interface AlphaAccount {
  username: string
  password: string
}

interface AlphaAccountsFile {
  accounts: AlphaAccount[]
}

interface StrongRef {
  uri: string
  cid: string
}

interface CapturedWrite {
  body: Record<string, unknown>
}

const DEFAULT_CLUBHOUSE_URL = 'https://clubhouse.atverkackt.de'
const DEFAULT_ROOM_ID = 'general'
const PDS_CREATE_PATH = '/xrpc/com.atproto.space.createRecord'

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function parseAccount(value: unknown): AlphaAccount {
  if (typeof value !== 'object' || value === null) {
    throw new Error('The selected account must be an object')
  }
  const account = value as Record<string, unknown>
  if (
    typeof account.username !== 'string' ||
    !account.username.trim() ||
    typeof account.password !== 'string' ||
    !account.password
  ) {
    throw new Error('The selected account needs non-empty username and password')
  }
  return { username: account.username, password: account.password }
}

async function loadAccount(path: string): Promise<AlphaAccount> {
  const parsed: unknown = JSON.parse(await Deno.readTextFile(path))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('The accounts file must contain an object')
  }
  const accounts = (parsed as AlphaAccountsFile).accounts
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('The accounts file must contain at least one account')
  }
  return parseAccount(accounts[0])
}

async function visible(locator: Locator): Promise<boolean> {
  return await locator.isVisible().catch(() => false)
}

async function clickFirstEnabled(locator: Locator): Promise<boolean> {
  const count = await locator.count()
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index)
    if (!(await visible(candidate)) || !(await candidate.isEnabled())) continue
    // OAuth controls often start navigation as they disable themselves. Do not
    // make a stale control turn that successful navigation into a timeout.
    await candidate.click({ noWaitAfter: true, timeout: 2_000 }).catch(() => {})
    return true
  }
  return false
}

async function completeOAuth(
  page: Page,
  account: AlphaAccount,
  clubhouseOrigin: string,
): Promise<void> {
  const deadline = Date.now() + 60_000
  let leftClubhouse = false
  while (Date.now() < deadline) {
    const current = new URL(page.url())
    if (current.origin !== clubhouseOrigin) leftClubhouse = true
    if (leftClubhouse && current.origin === clubhouseOrigin) return

    const password = page
      .locator('input[name="password"], input[type="password"]')
      .first()
    if (await visible(password)) {
      const username = page
        .locator(
          'input[name="username"]:not([readonly]):not([disabled]), input[name="identifier"]:not([readonly]):not([disabled])',
        )
        .first()
      if (await visible(username)) await username.fill(account.username)
      await password.fill(account.password)
      const submit = page
        .locator('button[type="submit"], button:has-text("Sign in")')
      if (await clickFirstEnabled(submit)) {
        await page.waitForTimeout(300)
        continue
      }
      else await page.keyboard.press('Enter')
      await page.waitForTimeout(300)
      continue
    }

    const consent = page
      .locator(
        'button:has-text("Accept"), button:has-text("Authorize"), button:has-text("Allow")',
      )
    if (await clickFirstEnabled(consent)) {
      await page.waitForTimeout(300)
      continue
    }
    await page.waitForTimeout(250)
  }
  throw new Error('Timed out while completing the PDS OAuth flow')
}

async function signIn(
  page: Page,
  account: AlphaAccount,
  clubhouseUrl: string,
): Promise<void> {
  const clubhouseOrigin = new URL(clubhouseUrl).origin
  await page.goto(clubhouseUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('#handle').fill(account.username)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await completeOAuth(page, account, clubhouseOrigin)
  await page.locator('.signed-in-account').waitFor({
    state: 'visible',
    timeout: 30_000,
  })
  const signedInAs = await page.locator('.header-note').textContent()
  assert(
    signedInAs?.includes(account.username),
    'Clubhouse did not hydrate the authenticated handle',
  )
  assert(
    await visible(page.getByRole('button', { name: 'Sign out' })),
    'Clubhouse did not expose a sign-out control',
  )
}

function roomCard(page: Page, roomId: string): Locator {
  return page.locator('.room-card', {
    has: page.locator(`a.room-link[href="/rooms/${encodeURIComponent(roomId)}"]`),
  })
}

async function waitForComposer(page: Page): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const composer = page.locator('#room-post')
    if (await visible(composer)) return

    const recheck = page.getByRole('button', { name: 'Check room again' })
    if (await visible(recheck)) {
      await recheck.click()
      await composer.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
      if (await visible(composer)) return
    }
    await page.reload({ waitUntil: 'domcontentloaded' })
    await composer.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
  }
  throw new Error('Room did not become ready after enrollment reconciliation')
}

async function enterRoom(
  page: Page,
  account: AlphaAccount,
  clubhouseUrl: string,
  roomId: string,
  allowMutation: boolean,
): Promise<void> {
  const card = roomCard(page, roomId)
  await card.waitFor({ state: 'visible', timeout: 30_000 })
  const open = card.getByRole('button', { name: 'Open room' })
  if (await visible(open)) {
    await open.click()
    await waitForComposer(page)
    return
  }

  const join = card.getByRole('button', { name: 'Join room' })
  assert(await visible(join), `Room ${roomId} has neither an open nor join action`)
  assert(
    allowMutation,
    'The account is not yet a member. Re-run with CLUBHOUSE_PUBLIC_E2E_MUTATE=true to test enrollment and writes.',
  )
  await join.click()
  await completeOAuth(page, account, new URL(clubhouseUrl).origin)
  await waitForComposer(page)
}

function capturePdsWrites(page: Page): CapturedWrite[] {
  const writes: CapturedWrite[] = []
  page.on('request', (request) => {
    if (
      request.method() !== 'POST' ||
      new URL(request.url()).pathname !== PDS_CREATE_PATH
    ) {
      return
    }
    const body = request.postData()
    if (!body) return
    try {
      writes.push({ body: JSON.parse(body) as Record<string, unknown> })
    } catch {
      // The assertions below reject an absent JSON request.
    }
  })
  return writes
}

function recordFromWrite(
  writes: readonly CapturedWrite[],
  text: string,
): Record<string, unknown> | undefined {
  return writes
    .map((write) => write.body.record)
    .find(
      (record): record is Record<string, unknown> =>
        typeof record === 'object' &&
        record !== null &&
        (record as Record<string, unknown>).text === text,
    )
}

function assertPdsRecord(
  record: Record<string, unknown> | undefined,
  text: string,
  reply?: { root: StrongRef; parent: StrongRef },
): void {
  assert(record !== undefined, `No PDS write was captured for ${text}`)
  assert(
    record.$type === 'zone.stratos.feed.post' &&
      record.text === text &&
      !('boundary' in record),
    'Clubhouse must use an unbounded space record for PDS custody',
  )
  if (!reply) {
    assert(!('reply' in record), 'A topic must not carry a reply reference')
    return
  }
  const actual = record.reply as
    | { root?: StrongRef; parent?: StrongRef }
    | undefined
  assert(
    actual?.root?.uri === reply.root.uri &&
      actual.root.cid === reply.root.cid &&
      actual.parent?.uri === reply.parent.uri &&
      actual.parent.cid === reply.parent.cid,
    'Clubhouse did not preserve the exact topic and parent strong references',
  )
}

async function submit(
  page: Page,
  text: string,
  reply = false,
): Promise<StrongRef> {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === PDS_CREATE_PATH &&
      response.ok(),
    { timeout: 45_000 },
  )
  if (reply) {
    await page.locator('#topic-reply').fill(text)
    await page.getByRole('button', { name: 'Post reply' }).click()
  } else {
    await page.locator('#room-post').fill(text)
    await page.getByRole('button', { name: 'Post topic' }).click()
  }
  const response = await responsePromise
  const body = (await response.json()) as Partial<StrongRef>
  assert(
    typeof body.uri === 'string' && typeof body.cid === 'string',
    'The spaces PDS writer did not return a post strong reference',
  )
  return { uri: body.uri, cid: body.cid }
}

async function waitForPost(page: Page, text: string): Promise<Locator> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const post = page.locator('.post', { hasText: text }).first()
    if (await visible(post)) return post
    await page.reload({ waitUntil: 'domcontentloaded' })
    await post.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
    if (await visible(post)) return post
  }
  throw new Error(`Feedgen did not hydrate the post: ${text}`)
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.locator('#handle').waitFor({ state: 'visible', timeout: 30_000 })
}

async function run(): Promise<void> {
  const account = await loadAccount(requiredEnvironment('CLUBHOUSE_PUBLIC_E2E_USERS_FILE'))
  const clubhouseUrl =
    Deno.env.get('CLUBHOUSE_PUBLIC_E2E_URL')?.trim() || DEFAULT_CLUBHOUSE_URL
  const roomId =
    Deno.env.get('CLUBHOUSE_PUBLIC_E2E_ROOM')?.trim() || DEFAULT_ROOM_ID
  const allowMutation = Deno.env.get('CLUBHOUSE_PUBLIC_E2E_MUTATE') === 'true'
  const executablePath = Deno.env.get('CLUBHOUSE_PUBLIC_E2E_BROWSER_PATH')?.trim()
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath, args: ['--no-sandbox'] } : {}),
  })

  try {
    const page = await browser.newPage()
    const writes = capturePdsWrites(page)
    await signIn(page, account, clubhouseUrl)
    console.log('Clubhouse public-alpha: sign-in and handle hydration passed')
    await page.locator('.room-card').first().waitFor({
      state: 'visible',
      timeout: 30_000,
    })
    assert(
      (await page.locator('.room-card').count()) > 0,
      'Clubhouse did not render a room catalogue after sign-in',
    )
    await enterRoom(page, account, clubhouseUrl, roomId, allowMutation)
    console.log('Clubhouse public-alpha: room is feed-ready')
    if (!allowMutation) {
      await signOut(page)
      console.log(JSON.stringify({ ok: true, roomId, writes: 0 }))
      return
    }

    const runId = Date.now()
    const topicText = `Clubhouse alpha E2E topic ${runId}`
    const topic = await submit(page, topicText)
    assertPdsRecord(recordFromWrite(writes, topicText), topicText)
    const topicCard = await waitForPost(page, topicText)
    await topicCard.getByRole('button', { name: 'Open topic' }).click()
    await page.locator('.thread-view').waitFor({ state: 'visible', timeout: 30_000 })
    assert(
      new URL(page.url()).searchParams.get('topic') === topic.uri,
      'Opening a topic did not create its shareable URI route',
    )
    await page.getByRole('button', { name: 'Reply to topic' }).click()
    const replyText = `Clubhouse alpha E2E reply ${runId}`
    const reply = await submit(page, replyText, true)
    assertPdsRecord(recordFromWrite(writes, replyText), replyText, {
      root: topic,
      parent: topic,
    })
    await waitForPost(page, replyText)
    assert(reply.uri.startsWith('at://'), 'Reply URI is not an AT URI')
    await signOut(page)
    console.log(JSON.stringify({ ok: true, roomId, writes: 2 }))
  } finally {
    await browser.close()
  }
}

run().catch((error: unknown) => {
  console.error(
    'Clubhouse public-alpha E2E failed:',
    error instanceof Error ? error.message : String(error),
  )
  Deno.exit(1)
})
