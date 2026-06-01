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

  test('should mock successful login and show feed', async ({ page }) => {
    // Listen for console logs
    page.on('console', (msg) =>
      console.log(`[BROWSER] ${msg.type()}: ${msg.text()}`),
    )

    // We'll mock the OAuth flow by manually setting a mock session in localStorage
    // and mocking the necessary API calls that App.svelte makes on startup.

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
            name: 'mock',
          }),
        })
      },
    )

    // Mock Stratos discovery
    await page.route(
      '**/xrpc/com.atproto.repo.listRecords?repo=did%3Aplc%3Amock&collection=zone.stratos.actor.enrollment',
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

    await page.addInitScript(() => {
      interface CustomWindow extends Window {
        __MOCK_SESSION__?: {
          sub: string
          handle?: string
        }
      }
      ;(window as unknown as CustomWindow).__MOCK_SESSION__ = {
        sub: 'did:plc:mock',
        handle: 'mock.bsky.social',
      }
    })

    await page.goto('/')

    // Verify UI shows handle
    await expect(page.getByText('@mock.bsky.social').first()).toBeVisible({
      timeout: 10000,
    })
  })
})
