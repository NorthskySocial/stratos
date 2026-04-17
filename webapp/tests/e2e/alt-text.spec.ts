import { expect, test } from '@playwright/test'

const STRATOS_URL = 'https://stratos.example.com'
const APPVIEW_URL = 'https://appview.example.com'

test.describe('Alt Text Support', () => {
  test.beforeEach(async ({ page }) => {
    // Inject mock session
    await page.addInitScript(() => {
      interface CustomWindow extends Window {
        __MOCK_SESSION__?: {
          sub: string
          handle?: string
          fetchHandler?: (url: string, init: Parameters<typeof fetch>[1]) => Promise<Response>
        }
      }
      ;(window as unknown as CustomWindow).__MOCK_SESSION__ = {
        sub: 'did:plc:mock',
        handle: 'mock.bsky.social',
        fetchHandler: async (url: string, init: Parameters<typeof fetch>[1]) => {
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
    await page.route('**/xrpc/zone.stratos.actor.getStatus**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enrolled: true }),
        headers: { 'Access-Control-Allow-Origin': '*' },
      })
    })

    // Mock server domains
    await page.route('**/xrpc/zone.stratos.server.getDomains', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ domains: ['example.com'] }),
        headers: { 'Access-Control-Allow-Origin': '*' },
      })
    })

    // Catch-all for other Stratos/Appview calls to ensure they return 200
    await page.route(url => 
      (url.href.includes(STRATOS_URL) || url.href.includes(APPVIEW_URL)) && 
      !url.href.includes('uploadBlob') && 
      !url.href.includes('createRecord') &&
      !url.href.includes('getStatus') &&
      !url.href.includes('getDomains'), 
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ feed: [], posts: [] }),
          headers: { 'Access-Control-Allow-Origin': '*' },
        })
      }
    )
  })

  test('should allow adding alt text to an uploaded image', async ({ page }) => {
    let createdRecord: { record: { embed: { images: Array<{ alt: string }> } } } | null = null

    // Mock blob upload
    await page.route(url => url.href.includes('uploadBlob'), async (route) => {
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
    })

    // Mock record creation
    await page.route(url => url.href.includes('createRecord'), async (route) => {
      createdRecord = route.request().postDataJSON() as { record: { embed: { images: Array<{ alt: string }> } } }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ uri: 'at://did:plc:mock/zone.stratos.feed.post/1', cid: 'cid1' }),
      })
    })

    await page.goto('/')

    // Wait for composer
    const composer = page.locator('.composer')
    await expect(composer).toBeVisible()

    // Type text
    await composer.locator('textarea').fill('Post with alt text')

    // Attach mock image
    const fileChooserPromise = page.waitForEvent('filechooser')
    await page.locator('.image-upload').click()
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles({
      name: 'test.png',
      mimeType: 'image/png',
      buffer: Buffer.from('mock image data'),
    })

    // Verify preview and alt text input visibility
    await expect(page.locator('.image-preview')).toBeVisible()
    const altTextInput = page.locator('.alt-text-input')
    await expect(altTextInput).toBeVisible()
    await expect(altTextInput).toHaveAttribute('placeholder', 'Add alt text…')

    // Fill alt text
    const testAltText = 'A beautiful sunset over the mountains'
    await altTextInput.fill(testAltText)

    // Post
    await page.locator('button:has-text("Post")').click()

    // Wait for record creation mock to be called
    await page.waitForFunction(() => (window as unknown as { recordCreated?: boolean }).recordCreated || true) // Simple wait

    // Wait a bit for the async call to complete
    await expect.poll(() => createdRecord).toBeTruthy()

    // Verify alt text in the created record
    expect(createdRecord.record.embed.images[0].alt).toBe(testAltText)

    // Verify UI is cleared
    await expect(composer.locator('textarea')).toHaveValue('')
    await expect(page.locator('.image-preview')).not.toBeVisible()
    await expect(altTextInput).not.toBeVisible()
  })
})
