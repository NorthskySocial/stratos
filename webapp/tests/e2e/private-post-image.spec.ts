import { expect, test } from '@playwright/test'

const STRATOS_URL = 'https://stratos.example.com'
const APPVIEW_URL = 'https://appview.example.com'

test.describe('Private Post with Image', () => {
  test.beforeEach(async ({ page }) => {
    // Inject mock session
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

    // Mock handle resolution
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

    // Mock Stratos enrollment
    await page.route(
      '**/xrpc/com.atproto.repo.listRecords?repo=did%3Aplc%3Amock&collection=zone.stratos.actor.enrollment',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            records: [
              {
                uri: 'at://did:plc:mock/zone.stratos.actor.enrollment/1',
                value: {
                  service: 'https://stratos.example.com',
                  boundaries: [{ value: 'example.com' }],
                  createdAt: new Date().toISOString(),
                },
              },
            ],
          }),
        })
      },
    )

    // Mock Stratos service status
    await page.route(
      '**/xrpc/zone.stratos.actor.getStatus**',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ enrolled: true }),
          headers: { 'Access-Control-Allow-Origin': '*' },
        })
      },
    )

    // Mock server domains
    await page.route(
      '**/xrpc/zone.stratos.server.getDomains',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ domains: ['example.com'] }),
          headers: { 'Access-Control-Allow-Origin': '*' },
        })
      },
    )

    // Catch-all for other Stratos/Appview calls to ensure they return 200
    await page.route(
      (url) =>
        (url.href.includes(STRATOS_URL) || url.href.includes(APPVIEW_URL)) &&
        !url.href.includes('uploadBlob') &&
        !url.href.includes('createRecord') &&
        !url.href.includes('getStatus') &&
        !url.href.includes('getDomains'),
      async (route) => {
        if (route.request().method() === 'OPTIONS') {
          await route.fulfill({
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': '*',
            },
          })
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ feed: [], posts: [] }),
            headers: { 'Access-Control-Allow-Origin': '*' },
          })
        }
      },
    )

    // Mock Stratos discovery/verification calls that might be made during startup
    await page.route(
      '**/xrpc/zone.stratos.attestation.verify**',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ valid: true }),
        })
      },
    )

    // Mock server domains
    await page.route(
      '**/xrpc/zone.stratos.server.getDomains',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ domains: ['example.com'] }),
        })
      },
    )

    // Mock initial feeds (empty)
    await page.route('**/xrpc/app.bsky.feed.getTimeline**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ feed: [] }),
      })
    })

    await page.route(
      '**/xrpc/com.atproto.repo.listRecords?repo=did%3Aplc%3Amock&collection=zone.stratos.feed.post',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ records: [] }),
        })
      },
    )
  })

  test('should create a private post with an image', async ({ page }) => {
    let blobUploaded = false
    let recordCreated = false

    // Mock blob upload
    await page.route(
      (url) => url.href.includes('uploadBlob'),
      async (route) => {
        blobUploaded = true
        await page.evaluate(() => {
          ;(window as unknown as { blobUploaded: boolean }).blobUploaded = true
        })
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({
            blob: {
              $type: 'blob',
              ref: { $link: 'bafkrei-mock-cid' },
              mimeType: 'image/png',
              size: 1234,
            },
          }),
        })
      },
    )

    // Mock record creation
    await page.route(
      (url) => url.href.includes('createRecord'),
      async (route) => {
        const body = route.request().postDataJSON()
        expect(body.collection).toBe('zone.stratos.feed.post')
        expect(body.record.text).toBe('Private post with image')
        expect(body.record.embed.$type).toBe('zone.stratos.embed.images')
        expect(body.record.embed.images[0].image.ref.$link).toBe(
          'bafkrei-mock-cid',
        )

        recordCreated = true
        await page.evaluate(() => {
          ;(window as unknown as { recordCreated: boolean }).recordCreated =
            true
        })
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({
            uri: 'at://did:plc:mock/zone.stratos.feed.post/1',
            cid: 'cid1',
          }),
        })
      },
    )

    // Go to home page
    await page.goto('/', { waitUntil: 'networkidle' })

    // Wait for composer to be ready
    const composer = page.locator('.composer')
    await expect(composer).toBeVisible()

    // Type text
    await composer.locator('textarea').fill('Private post with image')

    // Attach mock image
    const fileChooserPromise = page.waitForEvent('filechooser')
    await page.locator('.image-upload').click()
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles({
      name: 'test.png',
      mimeType: 'image/png',
      buffer: Buffer.from('mock image data'),
    })

    // Verify preview
    await expect(page.locator('.image-preview')).toBeVisible()

    // Ensure private is checked
    const privateToggle = page.locator('.private-toggle input')
    await expect(privateToggle).toBeChecked()

    // Post
    await page.locator('button:has-text("Post")').click()

    // Log for debugging
    await page.evaluate(() => {
      console.log('Post button clicked')
    })

    // Wait for mocks to be called
    try {
      await page.waitForFunction(
        () =>
          (
            window as unknown as {
              blobUploaded?: boolean
              recordCreated?: boolean
            }
          ).blobUploaded &&
          (
            window as unknown as {
              blobUploaded?: boolean
              recordCreated?: boolean
            }
          ).recordCreated,
        null,
        { timeout: 10000 },
      )
    } catch (e) {
      const errorText = await page
        .locator('.error')
        .innerText()
        .catch(() => 'No error in UI')
      console.log('UI Error:', errorText)

      // Take a screenshot of the failure for debugging
      await page.screenshot({ path: 'test-results/failure-debug.png' })

      throw e
    }

    expect(blobUploaded).toBe(true)
    expect(recordCreated).toBe(true)

    // Verify composer is cleared
    await expect(composer.locator('textarea')).toHaveValue('')
    await expect(page.locator('.image-preview')).not.toBeVisible()
  })
})
