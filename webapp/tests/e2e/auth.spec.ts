import { test, expect } from '@playwright/test'

test.describe('Authentication', () => {
  test('should show login screen when not authenticated', async ({ page }) => {
    // Listen for console logs
    page.on('console', (msg) =>
      console.log(`[BROWSER-LOGIN] ${msg.type()}: ${msg.text()}`),
    )

    // Mock the initial session check to return null
    await page.addInitScript(() => {
      window.localStorage.removeItem('atproto_oauth_session_did:plc:mock')
    })

    await page.goto('/')

    // Check if the login screen is eventually visible
    await expect(page.getByText('Private data for ATProto')).toBeVisible({
      timeout: 20000,
    })
    await expect(
      page.getByPlaceholder('Enter your handle (e.g. alice.bsky.social)'),
    ).toBeVisible()
  })

  test('renders the authenticated home for an injected mock session', async ({
    page,
  }) => {
    // Listen for console logs
    page.on('console', (msg) =>
      console.log(`[BROWSER] ${msg.type()}: ${msg.text()}`),
    )

    // This does NOT exercise the OAuth flow. It injects a session through the
    // dev-only __MOCK_SESSION__ seam and mocks the startup API calls, then
    // asserts the authenticated layout renders instead of the login screen.

    await page.route(
      '**/xrpc/com.atproto.repo.describeRepo?repo=did%3Aplc%3Amock',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            handle: 'mock.bsky.social',
            did: 'did:plc:mock',
            didDoc: {},
            collections: [],
            handleIsCorrect: true,
          }),
        })
      },
    )

    // Mock Stratos discovery
    await page.route(
      '**/xrpc/com.atproto.repo.listRecords?repo=did%3Aplc%3Amock&collection=zone.stratos.actor.enrollment**',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ records: [] }),
        })
      },
    )

    // Mock the public-post fallback that lists app.bsky.feed.post records
    await page.route(
      '**/xrpc/com.atproto.repo.listRecords?repo=did%3Aplc%3Amock&collection=app.bsky.feed.post**',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ records: [] }),
        })
      },
    )

    // Mock Public Feed
    await page.route('**/xrpc/app.bsky.feed.getTimeline**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ feed: [], cursor: 'mock-cursor' }),
      })
    })

    // Mock AppView author feed (called during startup)
    await page.route('**/xrpc/app.bsky.feed.getAuthorFeed**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ feed: [], cursor: 'mock-cursor' }),
      })
    })

    // Mock Stratos enrollment status
    await page.route(
      '**/xrpc/zone.stratos.enrollment.status**',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            enrolled: true,
            enrolledAt: new Date().toISOString(),
          }),
        })
      },
    )

    // Mock Stratos server listDomains
    await page.route(
      '**/xrpc/zone.stratos.server.listDomains**',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ domains: ['example.com'] }),
        })
      },
    )

    // Mock feedgen getFeed (proxied through PDS)
    await page.route(
      '**/xrpc/zone.stratos.feedgen.getFeed**',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ feed: [], cursor: 'mock-cursor' }),
        })
      },
    )

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

    await page.goto('/')

    // The authenticated layout renders: handle, composer, and sign-out.
    await expect(page.getByText('@mock.bsky.social').first()).toBeVisible({
      timeout: 10000,
    })
    await expect(page.locator('.composer')).toBeVisible()
    await expect(page.locator('button.sign-out')).toBeVisible()
    await expect(page.getByText('Private data for ATProto')).not.toBeVisible()
  })
})
