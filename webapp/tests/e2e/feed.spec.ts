import { expect, test } from '@playwright/test'

const STRATOS_URL = 'https://stratos.example.com'

const TOKYO3 = 'tokyo-3.example'
const JUUBAN = 'juuban.example'

const PUBLIC_TEXT = 'Public post: cherry blossoms over Tomoeda'
const TOKYO3_TEXT = 'Private sync report from Tokyo-3'
const JUUBAN_TEXT = 'Private study notes from Juuban'

const MOCK_DID = 'did:plc:mock'
const NOW = new Date().toISOString()

// The agent validates XRPC responses against the lexicons, so every cid must
// parse as a real CID. These are sha-256 dag-cbor CIDs of short label strings.
const PUBLIC_CID =
  'bafyreih2yrnyeilpckwrcq4e3jz6lynnzzp34yin2ayyzle42jitk6mamy'
const TOKYO3_CID =
  'bafyreidcjvtwxnvdosbs5dpbsd6usjywbcy5ecg4orv6cpfyban26ecpny'
const JUUBAN_CID =
  'bafyreieofcdccn6pwxz55peoltrspr3ptrlslnfwj4rzzb6fhjqeic4imm'
const ENROLLMENT_CID =
  'bafyreibhsg6uhfhpx4igepz42ma5yv7tp7yy74via2zmae2ah2c3yywfga'

const publicRepoRecord = {
  uri: `at://${MOCK_DID}/app.bsky.feed.post/1`,
  cid: PUBLIC_CID,
  value: {
    $type: 'app.bsky.feed.post',
    text: PUBLIC_TEXT,
    createdAt: NOW,
  },
}

const privateRepoRecords = [
  {
    uri: `at://${MOCK_DID}/zone.stratos.feed.post/1`,
    cid: TOKYO3_CID,
    value: {
      $type: 'zone.stratos.feed.post',
      text: TOKYO3_TEXT,
      createdAt: NOW,
      boundary: {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: [{ value: TOKYO3 }],
      },
    },
  },
  {
    uri: `at://${MOCK_DID}/zone.stratos.feed.post/2`,
    cid: JUUBAN_CID,
    value: {
      $type: 'zone.stratos.feed.post',
      text: JUUBAN_TEXT,
      createdAt: NOW,
      boundary: {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: [{ value: JUUBAN }],
      },
    },
  },
]

// The same posts in FeedViewPost shape, so the assertions also hold when the
// webapp is configured for the AppView or feedgen feed paths.
const privateFeedViewPosts = privateRepoRecords.map((r) => ({
  post: {
    uri: r.uri,
    cid: r.cid,
    author: { did: MOCK_DID, handle: 'mock.bsky.social' },
    record: r.value,
  },
}))

const enrollmentRecord = {
  uri: `at://${MOCK_DID}/zone.stratos.actor.enrollment/1`,
  cid: ENROLLMENT_CID,
  value: {
    $type: 'zone.stratos.actor.enrollment',
    service: STRATOS_URL,
    boundaries: [{ value: TOKYO3 }, { value: JUUBAN }],
    signingKey: 'did:key:zMockUserSigningKey',
    attestation: {
      sig: { $bytes: 'AAAA' },
      signingKey: 'did:key:zMockServiceSigningKey',
    },
    createdAt: NOW,
  },
}

test.describe('Feed rendering (authenticated)', () => {
  test.beforeEach(async ({ page }) => {
    // Inject a mock session whose fetchHandler goes through window.fetch so
    // page.route intercepts every agent call.
    await page.addInitScript(() => {
      interface CustomWindow extends Window {
        __MOCK_SESSION__?: {
          sub: string
          handle?: string
          fetchHandler?: (
            url: string,
            init: Parameters<typeof fetch>[1],
          ) => Promise<Response>
        }
      }
      ;(window as unknown as CustomWindow).__MOCK_SESSION__ = {
        sub: 'did:plc:mock',
        handle: 'mock.bsky.social',
        fetchHandler: async (
          url: string,
          init: Parameters<typeof fetch>[1],
        ) => {
          return await fetch(url, init)
        },
      }
    })

    // Catch-all for remaining Stratos service calls. Registered first so the
    // specific routes below take precedence (Playwright matches routes in
    // reverse registration order).
    await page.route(
      (url) => url.href.startsWith(STRATOS_URL),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ feed: [], posts: [], records: [] }),
          headers: { 'Access-Control-Allow-Origin': '*' },
        })
      },
    )

    await page.route(
      (url) => url.pathname.includes('com.atproto.repo.describeRepo'),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            handle: 'mock.bsky.social',
            did: MOCK_DID,
            didDoc: {},
            collections: [],
            handleIsCorrect: true,
          }),
        })
      },
    )

    // Enrollment discovery — both the listRecords and getRecord variants.
    await page.route(
      (url) =>
        url.pathname.includes('com.atproto.repo.listRecords') &&
        url.searchParams.get('collection') === 'zone.stratos.actor.enrollment',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ records: [enrollmentRecord] }),
        })
      },
    )
    await page.route(
      (url) =>
        url.pathname.includes('com.atproto.repo.getRecord') &&
        url.searchParams.get('collection') === 'zone.stratos.actor.enrollment',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(enrollmentRecord),
        })
      },
    )

    // Public posts — repo listRecords (default config) and the AppView
    // author-feed variant.
    await page.route(
      (url) =>
        url.pathname.includes('com.atproto.repo.listRecords') &&
        url.searchParams.get('collection') === 'app.bsky.feed.post',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ records: [publicRepoRecord] }),
        })
      },
    )
    await page.route('**/xrpc/app.bsky.feed.getAuthorFeed**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          feed: [
            {
              post: {
                uri: publicRepoRecord.uri,
                cid: publicRepoRecord.cid,
                author: { did: MOCK_DID, handle: 'mock.bsky.social' },
                record: publicRepoRecord.value,
              },
            },
          ],
        }),
      })
    })

    // Private posts — repo listRecords (default config) plus the AppView
    // timeline and feedgen variants.
    await page.route(
      (url) =>
        url.pathname.includes('com.atproto.repo.listRecords') &&
        url.searchParams.get('collection') === 'zone.stratos.feed.post',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ records: privateRepoRecords }),
          headers: { 'Access-Control-Allow-Origin': '*' },
        })
      },
    )
    await page.route(
      '**/xrpc/zone.stratos.feed.getTimeline**',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ feed: privateFeedViewPosts }),
          headers: { 'Access-Control-Allow-Origin': '*' },
        })
      },
    )
    await page.route(
      '**/xrpc/zone.stratos.feedgen.getFeed**',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ feed: privateFeedViewPosts }),
          headers: { 'Access-Control-Allow-Origin': '*' },
        })
      },
    )

    await page.route(
      '**/xrpc/zone.stratos.enrollment.status**',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ enrolled: true, enrolledAt: NOW }),
          headers: { 'Access-Control-Allow-Origin': '*' },
        })
      },
    )
    await page.route(
      '**/xrpc/zone.stratos.server.listDomains**',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ domains: [TOKYO3, JUUBAN] }),
          headers: { 'Access-Control-Allow-Origin': '*' },
        })
      },
    )
  })

  test('renders public and private posts with boundary badges', async ({
    page,
  }) => {
    await page.goto('/')

    // Authenticated header (folded in from the former home.spec.ts).
    await expect(page.getByText('@mock.bsky.social').first()).toBeVisible({
      timeout: 20000,
    })

    const publicCard = page.locator('.post-card:not(.private)', {
      hasText: PUBLIC_TEXT,
    })
    await expect(publicCard).toBeVisible({ timeout: 20000 })
    await expect(publicCard.locator('.private-badge')).toHaveCount(0)

    const tokyo3Card = page.locator('.post-card.private', {
      hasText: TOKYO3_TEXT,
    })
    await expect(tokyo3Card).toBeVisible()
    await expect(tokyo3Card.locator('.private-badge')).toHaveText('Private')
    await expect(tokyo3Card.locator('.domain-badge')).toHaveText(TOKYO3)

    const juubanCard = page.locator('.post-card.private', {
      hasText: JUUBAN_TEXT,
    })
    await expect(juubanCard).toBeVisible()
    await expect(juubanCard.locator('.private-badge')).toHaveText('Private')
    await expect(juubanCard.locator('.domain-badge')).toHaveText(JUUBAN)
  })

  test('boundary tabs filter private posts by domain', async ({ page }) => {
    await page.goto('/')

    const publicCard = page.locator('.post-card:not(.private)', {
      hasText: PUBLIC_TEXT,
    })
    const tokyo3Card = page.locator('.post-card.private', {
      hasText: TOKYO3_TEXT,
    })
    const juubanCard = page.locator('.post-card.private', {
      hasText: JUUBAN_TEXT,
    })

    await expect(tokyo3Card).toBeVisible({ timeout: 20000 })
    await expect(juubanCard).toBeVisible()

    // Both enrolled boundaries appear as feed tabs.
    const tabs = page.locator('.feed-tabs .tab')
    await expect(tabs.filter({ hasText: TOKYO3 })).toBeVisible()
    await expect(tabs.filter({ hasText: JUUBAN })).toBeVisible()

    // Selecting a boundary hides private posts outside it. Public posts stay.
    await tabs.filter({ hasText: TOKYO3 }).click()
    await expect(tokyo3Card).toBeVisible()
    await expect(juubanCard).not.toBeVisible()
    await expect(publicCard).toBeVisible()

    await tabs.filter({ hasText: JUUBAN }).click()
    await expect(juubanCard).toBeVisible()
    await expect(tokyo3Card).not.toBeVisible()
    await expect(publicCard).toBeVisible()

    // "All" restores the unfiltered feed.
    await tabs.filter({ hasText: 'All' }).click()
    await expect(tokyo3Card).toBeVisible()
    await expect(juubanCard).toBeVisible()
    await expect(publicCard).toBeVisible()
  })
})
