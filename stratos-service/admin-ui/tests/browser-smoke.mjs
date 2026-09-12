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
    },
    {
      ...base,
      boundary: 'did:web:nerv.test/archive',
      roomId: 'archive',
      displayName: 'Archive',
      status: 'inactive',
      memberCount: 0,
    },
  ]
  let failList = false,
    conflictNext = false,
    failConflictReload = false,
    drain = false
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
    if (url.pathname.startsWith('/xrpc/zone.stratos.admin.'))
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
  await expect(page.getByTestId('boundary-row')).toHaveCount(3)
  await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0)
  const row = (name) =>
    page
      .getByTestId('boundary-row')
      .filter({ has: page.getByRole('heading', { name, exact: true }) })
  await expect(
    row('All members').getByRole('button', { name: 'Deactivate', exact: true }),
  ).toHaveCount(0)
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
    row('Pilot recovery').getByRole('link', {
      name: 'Members (0)',
      exact: true,
    }),
  ).toHaveAttribute(
    'href',
    '#/enrollments?boundary=did%3Aweb%3Anerv.test%2Fpilots',
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
    .getByRole('link', { name: 'Members (0)', exact: true })
    .click()
  await expect(page).toHaveURL(
    /enrollments\?boundary=did%3Aweb%3Anerv.test%2Fpilots/,
  )
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
