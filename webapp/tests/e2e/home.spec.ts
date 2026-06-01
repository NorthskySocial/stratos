import { expect, test } from '@playwright/test'

test.describe('Home Screen (Authenticated)', () => {
  test.beforeEach(async ({ page }) => {
    // Inject mock session into localStorage and mock init function
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
      console.log('[DEBUG_LOG] Mock session injected in beforeEach')
    })

    // Mock successful handle resolution
    await page.route(
      '**/xrpc/com.atproto.repo.describeRepo?repo=did%3Aplc%3Amock',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            handle: 'mock.bsky.social',
            did: 'did:plc:mock',
          }),
        })
      },
    )

    // Mock Stratos discovery (no enrollment)
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
        body: JSON.stringify({
          feed: [
            {
              post: {
                uri: 'at://did:plc:mock/app.bsky.feed.post/1',
                cid: 'cid1',
                author: { handle: 'alice.bsky.social', displayName: 'Alice' },
                record: {
                  $type: 'app.bsky.feed.post',
                  text: 'Public post',
                  createdAt: new Date().toISOString(),
                },
              },
            },
          ],
        }),
      })
    })

    // Mock Stratos posts
    await page.route(
      '**/xrpc/com.atproto.repo.listRecords?repo=did%3Aplc%3Amock&collection=zone.stratos.feed.post',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            records: [
              {
                uri: 'at://did:plc:mock/zone.stratos.feed.post/1',
                cid: 'cid2',
                value: {
                  $type: 'zone.stratos.feed.post',
                  text: 'Private post',
                  createdAt: new Date().toISOString(),
                  boundary: {
                    $type: 'zone.stratos.boundary.defs#Domains',
                    values: [{ value: 'example.com' }],
                  },
                },
              },
            ],
          }),
        })
      },
    )
  })

  test('should show correct login elements', async ({ page }) => {
    // We can't easily unset the session if startup already ran,
    // so let's rely on auth.spec.ts for the non-authenticated state
    // and just use this test for the authenticated home screen.
    await page.goto('/')

    // Verify UI shows handle from mock
    await expect(page.getByText('@mock.bsky.social').first()).toBeVisible({
      timeout: 20000,
    })
  })
})
