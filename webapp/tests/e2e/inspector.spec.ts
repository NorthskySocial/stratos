import { expect, test, type Page } from '@playwright/test'

const STRATOS_URL = 'https://stratos.example.com'
const PDS_URL = 'https://pds.example.com'
const MOCK_DID = 'did:plc:mock'
const NOW = new Date().toISOString()

// The agent validates XRPC responses against the lexicons, so every cid must
// parse as a real CID.
const POST_CID = 'bafyreidcjvtwxnvdosbs5dpbsd6usjywbcy5ecg4orv6cpfyban26ecpny'
const ENROLLMENT_CID =
  'bafyreibhsg6uhfhpx4igepz42ma5yv7tp7yy74via2zmae2ah2c3yywfga'

const CUSTODY_POST_URI = `at://${MOCK_DID}/zone.stratos.feed.post/1`
const OTHER_AUTHOR_SPACE_URI =
  'at:space/did:web:bebop.example/zone.stratos.space.feed/crew/did:plc:fayevalentine/zone.stratos.feed.post/redtail'
const LEGACY_SPELLING_URI = `at://did:web:stratos.example.com/space/zone.stratos.space.feed/nerve/${MOCK_DID}/zone.stratos.feed.post/2`

const enrollmentRecord = {
  uri: `at://${MOCK_DID}/zone.stratos.actor.enrollment/1`,
  cid: ENROLLMENT_CID,
  value: {
    $type: 'zone.stratos.actor.enrollment',
    service: STRATOS_URL,
    boundaries: [{ value: 'tokyo-3.example' }],
    signingKey: 'did:key:zMockUserSigningKey',
    attestation: {
      sig: { $bytes: 'AAAA' },
      signingKey: 'did:key:zMockServiceSigningKey',
    },
    createdAt: NOW,
  },
}

function feedItem(
  uri: string,
  text: string,
  author = { did: MOCK_DID, handle: 'mock.bsky.social' },
) {
  return {
    post: {
      uri,
      cid: POST_CID,
      indexedAt: '2026-09-07T08:00:05.000Z',
      author,
      record: {
        $type: 'zone.stratos.feed.post',
        text,
        createdAt: NOW,
        boundary: {
          $type: 'zone.stratos.boundary.defs#Domains',
          values: [{ value: 'tokyo-3.example' }],
        },
      },
    },
  }
}

async function serveFeed(page: Page, items: unknown[]) {
  await page.addInitScript(() => {
    ;(window as unknown as Record<string, unknown>).__MOCK_SESSION__ = {
      sub: 'did:plc:mock',
      handle: 'mock.bsky.social',
      feedgenDid: 'did:web:batou.test',
      fetchHandler: async (url: string, init: Parameters<typeof fetch>[1]) =>
        fetch(url, init),
    }
  })

  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
    headers: { 'Access-Control-Allow-Origin': '*' },
  })

  await page.route(
    (url) => url.href.startsWith(STRATOS_URL),
    (route) => route.fulfill(json({ feed: [], posts: [], records: [] })),
  )
  await page.route(
    (url) => url.pathname.includes('com.atproto.repo.describeRepo'),
    (route) =>
      route.fulfill(
        json({
          handle: 'mock.bsky.social',
          did: MOCK_DID,
          didDoc: {},
          collections: [],
          handleIsCorrect: true,
        }),
      ),
  )
  await page.route(
    (url) =>
      url.pathname.includes('com.atproto.repo.listRecords') &&
      url.searchParams.get('collection') === 'zone.stratos.actor.enrollment',
    (route) => route.fulfill(json({ records: [enrollmentRecord] })),
  )
  await page.route(
    (url) =>
      url.pathname.includes('com.atproto.repo.getRecord') &&
      url.searchParams.get('collection') === 'zone.stratos.actor.enrollment',
    (route) => route.fulfill(json(enrollmentRecord)),
  )
  await page.route(
    (url) =>
      url.pathname.includes('com.atproto.repo.listRecords') &&
      url.searchParams.get('collection') !== 'zone.stratos.actor.enrollment',
    (route) => route.fulfill(json({ records: [] })),
  )
  await page.route('**/xrpc/app.bsky.feed.getAuthorFeed**', (route) =>
    route.fulfill(json({ feed: [] })),
  )
  await page.route('**/xrpc/zone.stratos.feedgen.getFeed**', (route) =>
    route.fulfill(json({ feed: items })),
  )
  await page.route('**/xrpc/zone.stratos.enrollment.status**', (route) =>
    route.fulfill(json({ enrolled: true, enrolledAt: NOW })),
  )
  await page.route('**/xrpc/zone.stratos.server.listDomains**', (route) =>
    route.fulfill(json({ domains: ['tokyo-3.example'] })),
  )
}

test.describe('Record inspector', () => {
  test('shows the public and the hydrated record of a custody post, closes on Escape and returns focus', async ({
    page,
  }) => {
    await serveFeed(page, [feedItem(CUSTODY_POST_URI, 'Sync report.')])
    await page.route('https://plc.directory/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          service: [{ id: '#atproto_pds', serviceEndpoint: PDS_URL }],
        }),
      }),
    )
    await page.route(`${PDS_URL}/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ value: { stub: 'the public stub' } }),
      }),
    )
    await page.route(
      (url) =>
        url.href.startsWith(STRATOS_URL) &&
        url.pathname.includes('com.atproto.repo.getRecord') &&
        url.searchParams.get('collection') === 'zone.stratos.feed.post',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ value: { hydrated: 'the private record' } }),
        }),
    )

    await page.goto('/')
    const card = page.locator('.post-card.private', { hasText: 'Sync report.' })
    await expect(card).toBeVisible({ timeout: 20000 })

    const opener = card.getByRole('button', {
      name: 'Inspect the public and private records',
    })
    await opener.focus()
    await opener.click()

    const dialog = page.getByRole('dialog', { name: 'Record Inspector' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Public Record')).toBeVisible()
    await expect(dialog.getByText('Private Hydrated Record')).toBeVisible()
    await expect(dialog.getByText('the public stub')).toBeVisible()
    await expect(dialog.getByText('the private record')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(opener).toBeFocused()
  })

  test('says an address in the earlier spelling is not valid and requests nothing', async ({
    page,
  }) => {
    await serveFeed(page, [feedItem(LEGACY_SPELLING_URI, 'Old address.')])
    const inspectorRequests: string[] = []
    page.on('request', (request) => {
      const url = request.url()
      if (
        url.startsWith('https://plc.directory') ||
        url.startsWith(PDS_URL) ||
        url.includes('com.atproto.space.getRecord') ||
        (url.includes('com.atproto.repo.getRecord') &&
          url.includes('zone.stratos.feed.post'))
      ) {
        inspectorRequests.push(url)
      }
    })

    await page.goto('/')
    const card = page.locator('.post-card.private', { hasText: 'Old address.' })
    await expect(card).toBeVisible({ timeout: 20000 })

    await card.getByRole('button', { name: 'Inspect this record' }).click()

    const dialog = page.getByRole('dialog', { name: 'Record Inspector' })
    await expect(dialog.getByRole('alert')).toHaveText(
      'This record address is not valid',
    )
    await expect(dialog.getByText('Public Record')).toHaveCount(0)
    expect(inspectorRequests).toEqual([])
  })

  test('shows another author space post as a feed snapshot and requests nothing', async ({
    page,
  }) => {
    await serveFeed(page, [
      feedItem(OTHER_AUTHOR_SPACE_URI, 'Redtail.', {
        did: 'did:plc:fayevalentine',
        handle: 'faye.example',
      }),
    ])
    const inspectorRequests: string[] = []
    page.on('request', (request) => {
      const url = request.url()
      if (
        url.startsWith('https://plc.directory') ||
        url.startsWith(PDS_URL) ||
        url.includes('com.atproto.space.getRecord') ||
        (url.includes('com.atproto.repo.getRecord') &&
          url.includes('zone.stratos.feed.post'))
      ) {
        inspectorRequests.push(url)
      }
    })

    await page.goto('/')
    const card = page.locator('.post-card.private', { hasText: 'Redtail.' })
    await expect(card).toBeVisible({ timeout: 20000 })

    await card
      .getByRole('button', { name: 'Inspect the copy the feed served' })
      .click()

    const dialog = page.getByRole('dialog', { name: 'Record Inspector' })
    await expect(dialog.getByText('Feed snapshot')).toBeVisible()
    await expect(dialog.locator('time')).toHaveAttribute(
      'datetime',
      '2026-09-07T08:00:05.000Z',
    )
    await expect(dialog.locator('pre')).toContainText('Redtail.')
    await expect(dialog.getByText('Public Record')).toHaveCount(0)
    expect(inspectorRequests).toEqual([])
  })
})
