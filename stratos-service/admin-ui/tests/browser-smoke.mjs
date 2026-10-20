/* global document, window */
import { env } from 'node:process'
import { log } from 'node:console'
import { URL } from 'node:url'

// Reuses the webapp's Playwright dev dependency; no service or account is needed.
const { chromium, expect } = await import(
  env.PLAYWRIGHT_MODULE ??
    '../../../webapp/node_modules/@playwright/test/index.mjs'
)
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 950 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const base = {
    description: 'Private conversations for the Tokyo-3 team.',
    listed: false,
    joinable: false,
    autoEnroll: false,
    appAccess: 'open',
    clientIds: [],
    status: 'active',
    revision: 1,
    memberCount: 2,
    reserved: false,
    createdAt: '1995-10-04T00:00:00Z',
    updatedAt: '1995-10-04T00:00:00Z',
  }
  let catalog = [
    {
      ...base,
      boundary: 'did:web:nerv.test/general',
      roomId: 'general',
      displayName: 'All members',
      reserved: true,
      autoEnroll: true,
      listed: true,
    },
    {
      ...base,
      boundary: 'did:web:nerv.test/pilots',
      roomId: 'pilots',
      displayName: 'Pilots',
      listed: true,
      joinable: true,
      appAccess: 'allowList',
      clientIds: ['https://spike.test/client'],
    },
    {
      ...base,
      boundary: 'did:web:nerv.test/archive',
      roomId: 'archive',
      displayName: 'Archive',
      status: 'inactive',
      memberCount: 0,
      listed: false,
      joinable: false,
      autoEnroll: true,
      appAccess: 'open',
      clientIds: [],
    },
    {
      ...base,
      boundary: 'did:web:nerv.test/' + 'archive-'.repeat(16) + 'long-id',
      roomId: 'long-id',
      displayName: 'Long identifier boundary',
      listed: false,
      joinable: false,
      autoEnroll: false,
    },
    {
      ...base,
      boundary: 'did:web:nerv.test/people',
      roomId: 'people',
      displayName: 'People policy',
      listed: false,
      joinable: true,
      autoEnroll: false,
    },
    {
      ...base,
      boundary: 'did:web:nerv.test/services',
      roomId: 'services',
      displayName: 'Service policy',
      listed: true,
      joinable: false,
      autoEnroll: false,
      appAccess: 'denyList',
      clientIds: ['https://blocked.test/client'],
    },
  ]
  let failList = false,
    failDetailList = false,
    conflictNext = false,
    failConflictReload = false,
    drain = false
  let catalogDelay = null
  let catalogDelayIndex = 0
  const catalogRequests = []
  const mutations = []
  async function handleMutation(route, url) {
    const method = url.pathname.split('.').at(-1)
    const body = route.request().postDataJSON()
    mutations.push({ method, body, verb: route.request().method() })
    if (route.request().method() !== 'POST')
      throw new Error('Expected XRPC POST')
    if (method === 'createBoundary') {
      const boundary = {
        ...base,
        ...body.settings,
        boundary: 'did:web:nerv.test/' + body.name,
        roomId: body.name,
        memberCount: 0,
      }
      catalog.push(boundary)
      return route.fulfill({ json: { boundary } })
    }
    const current = catalog.find((b) => b.boundary === body.boundary)
    if (conflictNext) {
      conflictNext = false
      catalog = catalog.map((b) =>
        b === current
          ? {
              ...b,
              revision: b.revision + 1,
              displayName: 'Pilots — updated by Rei',
            }
          : b,
      )
      if (failConflictReload) failList = true
      return route.fulfill({
        status: 400,
        json: { error: 'BoundaryConflict', message: 'The boundary changed.' },
      })
    }
    if (body.revision !== current.revision)
      throw new Error('Stale revision: ' + JSON.stringify(body))
    let boundary = { ...current, revision: current.revision + 1 }
    if (method === 'updateBoundary')
      boundary = { ...boundary, ...body.settings }
    if (method === 'deactivateBoundary') {
      boundary.status = 'deactivating'
      drain = true
    }
    if (method === 'reactivateBoundary') {
      boundary.status = 'active'
      boundary.memberCount = 0
    }
    catalog = catalog.map((b) => (b === current ? boundary : b))
    return route.fulfill({ json: { boundary } })
  }
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname !== '127.0.0.1' || url.port !== '6174')
      return route.abort()
    if (url.pathname === '/admin/whoami')
      return route.fulfill({ json: { did: 'did:plc:spike', isAdmin: true } })
    if (url.pathname === '/xrpc/zone.stratos.admin.listBoundaries') {
      catalogRequests.push(route)
      if (catalogDelay) {
        const delayedCatalog = catalogDelay
        const index = catalogDelayIndex++
        if (index === 0) await delayedCatalog.releaseStale
        await route.fulfill({
          json: { boundaries: delayedCatalog.responses[index] },
        })
        if (index === 0) delayedCatalog.markStaleFulfilled()
        return
      }
      if (failDetailList) {
        failDetailList = false
        return route.fulfill({
          status: 503,
          json: { error: 'Unavailable', message: 'Catalog unavailable.' },
        })
      }
      if (failList) {
        failList = false
        return route.fulfill({
          status: 503,
          json: {
            error: 'Unavailable',
            message: 'Catalog is temporarily unavailable.',
          },
        })
      }
      if (drain) {
        catalog = catalog.map((b) =>
          b.status === 'deactivating'
            ? {
                ...b,
                status: 'inactive',
                memberCount: 0,
                revision: b.revision + 1,
              }
            : b,
        )
        drain = false
      }
      return route.fulfill({ json: { boundaries: catalog } })
    }
    if (url.pathname === '/xrpc/zone.stratos.server.listDomains')
      return route.fulfill({
        json: {
          domains: catalog
            .filter((b) => b.status === 'active')
            .map((b) => b.boundary),
        },
      })
    if (url.pathname === '/xrpc/zone.stratos.admin.listEnrollments')
      return route.fulfill({ json: { enrollments: [], total: 0 } })
    if (
      url.pathname.startsWith('/xrpc/zone.stratos.admin.') &&
      ![
        '/xrpc/zone.stratos.admin.createBoundary',
        '/xrpc/zone.stratos.admin.updateBoundary',
        '/xrpc/zone.stratos.admin.deactivateBoundary',
        '/xrpc/zone.stratos.admin.reactivateBoundary',
      ].includes(url.pathname)
    )
      throw new Error('Unexpected admin endpoint: ' + url.pathname)
    if (
      url.pathname === '/xrpc/zone.stratos.admin.createBoundary' ||
      url.pathname === '/xrpc/zone.stratos.admin.updateBoundary' ||
      url.pathname === '/xrpc/zone.stratos.admin.deactivateBoundary' ||
      url.pathname === '/xrpc/zone.stratos.admin.reactivateBoundary'
    )
      return handleMutation(route, url)
    if (
      url.pathname.startsWith('/xrpc/') ||
      url.pathname.startsWith('/admin/') ||
      url.pathname === '/health'
    )
      return route.abort()
    return route.continue()
  })
  await page.goto('http://127.0.0.1:6174/#/domains')
  await expect(
    page.getByRole('heading', { name: 'Boundaries', exact: true }),
  ).toBeVisible()
  await expect(page.getByTestId('boundary-row')).toHaveCount(6)
  await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0)
  const row = (name) =>
    page
      .getByTestId('boundary-row')
      .filter({ has: page.getByRole('heading', { name, exact: true }) })
  await expect(
    row('All members').getByRole('button', { name: 'Deactivate', exact: true }),
  ).toHaveCount(0)
  const overviewHref =
    '#/boundaries/detail?boundary=did%3Aweb%3Anerv.test%2Fpilots&tab=overview'
  await row('Pilots')
    .getByRole('link', { name: 'Overview', exact: true })
    .click()
  await expect(page).toHaveURL((url) => url.hash === overviewHref)
  await expect(page.getByTestId('boundary-overview')).toContainText(
    'Directory listing does not make boundary content public',
  )
  await expect(page.getByTestId('boundary-overview')).toContainText(
    'Allowed application IDs',
  )
  await expect(page.getByTestId('boundary-overview')).toContainText(
    'https://spike.test/client',
  )
  await expect(page.getByTestId('boundary-detail')).toContainText('Pilots')
  await expect(
    page.getByTestId('admin-shell').getByTestId('whoami-did'),
  ).toContainText('did:plc:spike')
  await expect(page.getByTestId('boundary-overview')).toContainText(
    'Publicly listed',
  )
  await expect(page.getByTestId('boundary-overview')).toContainText(
    'Members may join',
  )
  await expect(page.getByTestId('boundary-overview')).toContainText(
    'Automatic enrollment',
  )
  await expect(page.getByTestId('boundary-overview')).toContainText('Disabled')
  await expect(page.getByTestId('boundary-overview')).toContainText(
    'Application policy',
  )
  await expect(page.getByTestId('boundary-overview')).toContainText(
    'Allowlisted applications',
  )
  await expect(page.getByTestId('boundary-detail')).toContainText(
    'did:web:nerv.test/pilots',
  )
  await expect(
    page
      .getByRole('navigation', { name: 'Administration' })
      .getByRole('link', { name: 'Boundaries' }),
  ).toHaveClass(/grad-fill/)
  expect(mutations).toHaveLength(0)
  await page.reload()
  await expect(page.getByTestId('boundary-overview')).toBeVisible()
  await expect(page.getByTestId('boundary-detail')).toContainText(
    'did:web:nerv.test/pilots',
  )
  await expect(page).toHaveURL((url) => url.hash === overviewHref)
  await page.goto(
    'http://127.0.0.1:6174/#/boundaries/detail?boundary=did%3Aweb%3Anerv.test%2Farchive&tab=overview',
  )
  await expect(page.getByTestId('boundary-detail')).toContainText('Archive')
  await expect(page.getByTestId('boundary-detail')).toContainText(
    'did:web:nerv.test/archive',
  )
  await expect(page).toHaveURL(
    /boundary=did%3Aweb%3Anerv.test%2Farchive&tab=overview/,
  )
  let releaseStaleCatalog
  let markStaleFulfilled
  const staleCatalogReleased = new Promise((resolve) => {
    releaseStaleCatalog = resolve
  })
  const staleCatalogFulfilled = new Promise((resolve) => {
    markStaleFulfilled = resolve
  })
  catalogDelay = {
    releaseStale: staleCatalogReleased,
    markStaleFulfilled,
    responses: [
      catalog.filter((boundary) => boundary.displayName === 'Pilots'),
      catalog.filter((boundary) => boundary.displayName === 'Archive'),
    ],
  }
  catalogDelayIndex = 0
  catalogRequests.length = 0
  await page.goto(
    'http://127.0.0.1:6174/#/boundaries/detail?boundary=did%3Aweb%3Anerv.test%2Fpilots&tab=overview',
  )
  await page.evaluate(() => {
    window.location.hash =
      '#/boundaries/detail?boundary=did%3Aweb%3Anerv.test%2Farchive&tab=overview'
  })
  await expect(page).toHaveURL(
    /boundary=did%3Aweb%3Anerv.test%2Farchive&tab=overview/,
  )
  await expect(page.getByTestId('boundary-detail')).toContainText('Archive')
  await expect(page.getByTestId('boundary-detail')).not.toContainText('Pilots')
  await expect.poll(() => catalogRequests.length).toBe(2)
  expect(catalogRequests).toHaveLength(2)
  await expect.poll(() => catalogDelayIndex).toBe(2)
  releaseStaleCatalog()
  await staleCatalogFulfilled
  await expect(page.getByTestId('boundary-detail')).toContainText('Archive')
  await expect(page.getByTestId('boundary-detail')).not.toContainText('Pilots')
  await expect(page).toHaveURL(
    /boundary=did%3Aweb%3Anerv.test%2Farchive&tab=overview/,
  )
  catalogDelay = null
  await page.goto('http://127.0.0.1:6174/#/domains')
  await expect(page.getByTestId('boundary-row')).toHaveCount(6)
  await page.goBack()
  await expect(page).toHaveURL(/boundaries\/detail/)
  await expect(page.getByTestId('boundary-detail')).toContainText('Archive')
  await expect(page).toHaveURL(
    /boundary=did%3Aweb%3Anerv.test%2Farchive&tab=overview/,
  )
  await page.goForward()
  await expect(page).toHaveURL(/domains/)
  await expect(
    page.getByRole('heading', { name: 'Boundaries', exact: true }),
  ).toBeVisible()
  await row('Pilots')
    .getByRole('link', { name: 'Overview', exact: true })
    .click()
  await expect(page.getByTestId('boundary-overview')).toBeVisible()
  await page.goto(
    'http://127.0.0.1:6174/#/boundaries/detail?boundary=did%3Aweb%3Anerv.test%2Fpilots&tab=members',
  )
  await expect(page).toHaveURL(/tab=members/)
  await expect(page.getByTestId('boundary-detail')).toContainText('Pilots')
  await expect(
    page.getByRole('link', { name: 'Return to boundaries', exact: true }),
  ).toBeVisible()
  await page.goto(
    'http://127.0.0.1:6174/#/boundaries/detail?boundary=did%3Aweb%3Anerv.test%2Fpilots&tab=settings',
  )
  await expect(page).toHaveURL(/tab=settings/)
  await expect(page.getByTestId('boundary-detail')).toContainText('Pilots')
  await expect(
    page.getByRole('link', { name: 'Return to boundaries', exact: true }),
  ).toBeVisible()
  await page.goto(
    'http://127.0.0.1:6174/#/boundaries/detail?boundary=unknown%2Fboundary&tab=members',
  )
  await expect(page.getByTestId('boundary-not-found')).toContainText(
    'not in the current catalog',
  )
  await expect(
    page.getByRole('link', { name: 'Return to boundaries' }),
  ).toBeVisible()
  expect(mutations).toHaveLength(0)
  await page.goto('http://127.0.0.1:6174/#/boundaries/detail?tab=overview')
  await expect(page.getByTestId('boundary-not-found')).toContainText(
    'missing or invalid',
  )
  expect(mutations).toHaveLength(0)
  failDetailList = true
  await page.goto(
    'http://127.0.0.1:6174/#/boundaries/detail?boundary=did%3Aweb%3Anerv.test%2Fpilots&tab=overview',
  )
  await expect(page.getByRole('alert')).toContainText('Catalog unavailable')
  expect(mutations).toHaveLength(0)
  await page.getByRole('button', { name: 'Retry loading', exact: true }).click()
  await expect(page.getByTestId('boundary-overview')).toBeVisible()
  await page.goto('http://127.0.0.1:6174/#/domains')
  await expect(page.getByTestId('boundary-row')).toHaveCount(6)
  await row('All members')
    .getByRole('button', { name: 'Edit', exact: true })
    .click()
  await expect(
    page.getByLabel('Add new enrollments automatically'),
  ).toBeChecked()
  await expect(
    page.getByLabel('Add new enrollments automatically'),
  ).toBeDisabled()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByTestId('create-boundary').click()
  await expect(
    page.getByLabel('Boundary name', { exact: true }),
  ).toHaveAccessibleDescription(/permanent identifier/)
  await page.getByLabel('Boundary name', { exact: true }).fill('bebop')
  await page.getByLabel('Display name', { exact: true }).fill('Bebop')
  await page
    .getByLabel('Description', { exact: true })
    .fill('See you, space cowboy.')
  await expect(
    page.getByLabel('App access', { exact: true }),
  ).toHaveAccessibleDescription(/must still belong/)
  await page.getByLabel('App access', { exact: true }).selectOption('allowList')
  await expect(
    page.getByLabel('Allowed client IDs', { exact: true }),
  ).toHaveAccessibleDescription(/One HTTPS/)
  await page
    .getByLabel('Allowed client IDs', { exact: true })
    .fill('https://spike.test/client\n https://faye.test/client ')
  await page
    .getByRole('button', { name: 'Create boundary', exact: true })
    .click()
  await expect(row('Bebop')).toBeVisible()
  expect(mutations.at(-1)).toEqual({
    method: 'createBoundary',
    verb: 'POST',
    body: {
      name: 'bebop',
      settings: {
        displayName: 'Bebop',
        description: 'See you, space cowboy.',
        listed: false,
        joinable: false,
        autoEnroll: false,
        appAccess: 'allowList',
        clientIds: ['https://spike.test/client', 'https://faye.test/client'],
      },
    },
  })
  await row('Pilots').getByRole('button', { name: 'Edit', exact: true }).click()
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Pilot operations')
  conflictNext = true
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Your form values are still here',
  )
  await expect(page.getByRole('alert')).toBeFocused()
  await expect(page.getByLabel('Display name', { exact: true })).toHaveValue(
    'Pilot operations',
  )
  await expect(
    page
      .getByTestId('boundary-editor')
      .getByText('Pilots — updated by Rei', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(row('Pilot operations')).toBeVisible()
  expect(mutations.at(-1).body.revision).toBe(2)
  await row('Pilot operations')
    .getByRole('button', { name: 'Edit', exact: true })
    .click()
  await page.getByLabel('Display name', { exact: true }).fill('Pilot recovery')
  conflictNext = true
  failConflictReload = true
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('could not be loaded')
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled()
  await page.getByRole('button', { name: 'Retry loading', exact: true }).click()
  await expect(page.getByLabel('Display name', { exact: true })).toHaveValue(
    'Pilot recovery',
  )
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeEnabled()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(row('Pilot recovery')).toBeVisible()
  await row('Pilot recovery')
    .getByRole('button', { name: 'Deactivate', exact: true })
    .click()
  await expect(page.getByTestId('deactivation-confirmation')).toContainText(
    'All 2 members will be removed',
  )
  await expect(page.getByTestId('deactivation-confirmation')).toContainText(
    'Records and the boundary name will be retained',
  )
  await page
    .getByRole('button', { name: 'Remove members and deactivate', exact: true })
    .click()
  await expect(row('Pilot recovery')).toContainText(
    'Removing members: 2 remaining',
  )
  await expect(
    row('Pilot recovery').getByText('Inactive', { exact: true }),
  ).toBeVisible({ timeout: 10000 })
  await row('Pilot recovery')
    .getByRole('button', { name: 'Reactivate', exact: true })
    .click()
  await expect(
    row('Pilot recovery').getByText('Active', { exact: true }),
  ).toBeVisible()
  await expect(
    row('Pilot recovery').getByRole('link', { name: 'Overview', exact: true }),
  ).toHaveAttribute(
    'href',
    '#/boundaries/detail?boundary=did%3Aweb%3Anerv.test%2Fpilots&tab=overview',
  )
  failList = true
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Catalog is temporarily unavailable',
  )
  await page.getByRole('button', { name: 'Retry loading', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.screenshot({
    path: '/tmp/boundary-ui-final-desktop.png',
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: '/tmp/boundary-ui-final-mobile.png',
    fullPage: true,
  })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
  await row('Bebop').getByRole('button', { name: 'Edit', exact: true }).click()
  await page
    .getByTestId('boundary-editor')
    .screenshot({ path: '/tmp/boundary-ui-form-mobile.png' })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await expect(page.locator('body')).toHaveCSS('color', 'rgb(255, 255, 255)')
  await page
    .getByTestId('boundary-editor')
    .screenshot({ path: '/tmp/boundary-ui-form-dark.png' })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await row('Pilot recovery')
    .getByRole('link', { name: /Global enrollments/ })
    .click()
  await expect(page).toHaveURL(
    /enrollments\?boundary=did%3Aweb%3Anerv.test%2Fpilots/,
  )
  await page.goto(
    'http://127.0.0.1:6174/#/boundaries/detail?boundary=did%3Aweb%3Anerv.test%2F' +
      'archive-'.repeat(16) +
      'long-id&tab=overview',
  )
  await expect(page.getByTestId('boundary-detail')).toContainText(
    'Long identifier boundary',
  )
  await page.keyboard.press('Tab')
  await expect(
    page.getByRole('link', { name: '← All boundaries' }),
  ).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(
    page.getByRole('link', { name: 'Overview', exact: true }),
  ).toBeFocused()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('boundary-detail')).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
  expect(errors).toEqual([])
  log(
    JSON.stringify({
      status: 'PASS',
      mutations: mutations.length,
      checks: [
        'domains route alias',
        'reserved boundary constraints',
        'create exact XRPC payload',
        'conflict preserves draft and reloads revision',
        'conflict reload failure and retry',
        'deactivate confirmation',
        'deactivating progress polling',
        'reactivate empty',
        'members link',
        'load failure and retry',
        'no delete control',
        '390px without overflow',
        'desktop/mobile/dark screenshots',
        'no browser exceptions',
      ],
    }),
  )
} finally {
  await browser.close()
}
