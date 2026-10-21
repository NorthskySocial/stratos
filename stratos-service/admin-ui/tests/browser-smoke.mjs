/* global document, window */
import { env } from 'node:process'
import { log } from 'node:console'
import { URL, URLSearchParams } from 'node:url'

// Reuses the webapp's Playwright dev dependency; no service or account is needed.
const { chromium, expect } = await import(
  env.PLAYWRIGHT_MODULE ??
    '../../../webapp/node_modules/@playwright/test/index.mjs'
)
const browser = await chromium.launch({ headless: true })
try {
  let page = await browser.newPage({ viewport: { width: 1200, height: 950 } })
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
  let saveGate = null
  let deferredPoll = null
  let catalogDelay = null
  let catalogDelayIndex = 0
  const catalogRequests = []
  const membershipRequests = []
  const enrollmentReads = []
  const membershipMutations = []
  const enrollmentState = new Map([
    [
      'did:plc:shin',
      {
        enrolled: true,
        active: true,
        boundaries: ['did:web:nerv.test/pilots', 'did:web:nerv.test/people'],
      },
    ],
    [
      'did:plc:rei',
      {
        enrolled: true,
        active: false,
        boundaries: ['did:web:nerv.test/people'],
      },
    ],
    [
      'did:plc:service',
      {
        enrolled: true,
        active: true,
        boundaries: ['did:web:nerv.test/pilots'],
      },
    ],
    ['did:plc:unenrolled', { enrolled: false, active: false, boundaries: [] }],
  ])
  let membershipFault = ''
  let authFault = ''
  let listFailure = ''
  let settingsRefreshFault = ''
  let refreshCatalogFailure = false
  let failCatalogAfterMembershipSave = false
  let contradictoryMembership = false
  let paginationCursor = null
  let failNextCursor = true
  let pendingListFilter = null
  let releasePendingListFilter = null
  const pendingFilterStarted = []
  async function handleMembership(route, url) {
    const pathname = url.pathname
    if (pathname.endsWith('.listEnrollments')) {
      membershipRequests.push({
        pathname,
        search: url.search,
        method: route.request().method(),
      })
      if (pendingListFilter && url.searchParams.get('active') === 'true') {
        const gate = activeFilterGate
        pendingListFilter = null
        pendingFilterStarted.shift()?.()
        await gate
        return route.fulfill({
          json: {
            enrollments: [
              {
                did: 'did:plc:shin',
                active: true,
                custody: 'stratos',
                boundaries: [],
              },
            ],
            total: 1,
          },
        })
      }
      if (listFailure) {
        const fault = listFailure
        listFailure = ''
        return route.fulfill({
          status: Number(fault),
          json: { error: 'Unavailable', message: 'Member page unavailable.' },
        })
      }
      const boundary = url.searchParams.get('boundary')
      if (paginationCursor && !url.searchParams.get('cursor')) {
        paginationCursor = null
        return route.fulfill({
          json: {
            enrollments: [
              {
                did: 'did:plc:shin',
                active: true,
                custody: 'stratos',
                isService: false,
                boundaries: [boundary],
              },
            ],
            cursor: 'next-page',
            total: 3,
          },
        })
      }
      if (url.searchParams.get('cursor') && failNextCursor) {
        failNextCursor = false
        return route.fulfill({
          status: 503,
          json: { error: 'Unavailable', message: 'Member page unavailable.' },
        })
      }
      if (url.searchParams.get('cursor'))
        return route.fulfill({
          json: {
            enrollments: [
              {
                did: 'did:plc:service',
                active: true,
                custody: 'stratos',
                isService: true,
                boundaries: [boundary],
              },
            ],
          },
        })
      const members = [...enrollmentState]
        .filter(
          ([, state]) => state.enrolled && state.boundaries.includes(boundary),
        )
        .map(([did, state]) => ({
          did,
          enrolledAt: '1995-10-04T00:00:00Z',
          active: state.active,
          isService: did === 'did:plc:service',
          custody: 'stratos',
          boundaries: state.boundaries,
        }))
      const active = url.searchParams.get('active')
      const custody = url.searchParams.get('custody')
      const filtered = members.filter(
        (member) =>
          (active === null || String(member.active) === active) &&
          (custody === null || member.custody === custody),
      )
      return route.fulfill({ json: { enrollments: filtered } })
    }
    if (pathname.endsWith('.resolveEnrollments')) {
      const did = url.searchParams.get('did')
      enrollmentReads.push(did)
      const state = enrollmentState.get(did) ?? {
        enrolled: false,
        active: false,
        boundaries: [],
      }
      return route.fulfill({
        json: { did, enrolled: state.enrolled, boundaries: state.boundaries },
      })
    }
    if (pathname.endsWith('.status')) {
      const did = url.searchParams.get('did')
      const state = enrollmentState.get(did) ?? {
        enrolled: false,
        active: false,
        boundaries: [],
      }
      return route.fulfill({
        json: { did, enrolled: state.enrolled, active: state.active },
      })
    }
    if (pathname.endsWith('.getRepoHost')) {
      const did = url.searchParams.get('did')
      return route.fulfill({
        json: {
          did,
          custody: 'stratos',
          isService: did === 'did:plc:service',
          resolutions: [],
        },
      })
    }
    if (
      pathname.endsWith('.addBoundary') ||
      pathname.endsWith('.removeBoundary')
    ) {
      const body = route.request().postDataJSON()
      const method = pathname.split('.').at(-1)
      membershipMutations.push({ method, body, verb: route.request().method() })
      if (authFault) {
        const status = Number(authFault)
        authFault = ''
        return route.fulfill({
          status,
          json: { error: 'AuthRequired', message: 'Operator session expired.' },
        })
      }
      if (
        membershipFault === '401' ||
        membershipFault === '403' ||
        membershipFault === '500' ||
        membershipFault === '500-no-save' ||
        membershipFault === 'drop' ||
        membershipFault === 'drop-no-save'
      ) {
        const fault = membershipFault
        membershipFault = ''
        if (
          (fault === '500' || fault === 'drop') &&
          enrollmentState.has(body.did)
        )
          enrollmentState.get(body.did).boundaries =
            method === 'addBoundary'
              ? [
                  ...new Set([
                    ...enrollmentState.get(body.did).boundaries,
                    body.boundary,
                  ]),
                ]
              : enrollmentState
                  .get(body.did)
                  .boundaries.filter((item) => item !== body.boundary)
        if (fault === 'drop' || fault === 'drop-no-save')
          return route.abort('failed')
        return route.fulfill({
          status: fault === '500-no-save' ? 500 : Number(fault),
          json: {
            error:
              fault === '500' || fault === '500-no-save'
                ? 'Unavailable'
                : 'AuthRequired',
            message: 'Membership response failure.',
          },
        })
      }
      const state = enrollmentState.get(body.did)
      if (contradictoryMembership) {
        contradictoryMembership = false
        return route.fulfill({
          json: { did: body.did, boundaries: state.boundaries, pdsSync: 'ok' },
        })
      }
      state.boundaries =
        method === 'addBoundary'
          ? [...new Set([...state.boundaries, body.boundary])]
          : state.boundaries.filter((item) => item !== body.boundary)
      if (failCatalogAfterMembershipSave) {
        failCatalogAfterMembershipSave = false
        refreshCatalogFailure = true
      }
      return route.fulfill({
        json: {
          did: body.did,
          boundaries: state.boundaries,
          pdsSync:
            membershipFault === 'deferred'
              ? ((membershipFault = ''), 'deferred')
              : 'ok',
        },
      })
    }
    throw new Error('Unexpected membership endpoint: ' + pathname)
  }
  const mutations = []
  async function handleMutation(route, url) {
    const method = url.pathname.split('.').at(-1)
    const body = route.request().postDataJSON()
    mutations.push({ method, body, verb: route.request().method() })
    if (saveGate) await saveGate
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
    if (url.pathname === '/xrpc/com.atproto.identity.resolveHandle')
      return route.fulfill({ json: { did: 'did:plc:rei' } })
    if (url.pathname === '/admin/oauth/logout')
      return route.fulfill({ json: { success: true } })
    if (url.pathname === '/admin/whoami') {
      if (authFault === 'restore') {
        authFault = ''
        return route.fulfill({ json: { did: 'did:plc:spike', isAdmin: true } })
      }
      if (authFault) {
        const fault = authFault
        authFault = ''
        if (fault === '403')
          return route.fulfill({
            json: { did: 'did:plc:spike', isAdmin: true },
          })
        return route.fulfill({ status: 401, json: { error: 'AuthRequired' } })
      }
      return route.fulfill({ json: { did: 'did:plc:spike', isAdmin: true } })
    }
    if (url.pathname === '/xrpc/zone.stratos.admin.listBoundaries') {
      catalogRequests.push(route)
      if (deferredPoll) {
        await deferredPoll
        return route.fulfill({ json: { boundaries: catalog } })
      }
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
      if (settingsRefreshFault) {
        const fault = settingsRefreshFault
        settingsRefreshFault = ''
        if (fault === 'network') return route.abort('failed')
        return route.fulfill({
          status: 500,
          json: { error: 'Unavailable', message: 'Settings refresh failed.' },
        })
      }
      if (refreshCatalogFailure) {
        refreshCatalogFailure = false
        return route.fulfill({
          status: 503,
          json: { error: 'Unavailable', message: 'Catalog refresh failed.' },
        })
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
      const boundaries = catalog.map((item) => ({
        ...item,
        memberCount: [...enrollmentState.values()].filter(
          (state) => state.enrolled && state.boundaries.includes(item.boundary),
        ).length,
      }))
      return route.fulfill({ json: { boundaries } })
    }
    if (url.pathname === '/xrpc/zone.stratos.server.listDomains')
      return route.fulfill({
        json: {
          domains: catalog
            .filter((b) => b.status === 'active')
            .map((b) => b.boundary),
        },
      })
    if (
      url.pathname === '/xrpc/zone.stratos.admin.listEnrollments' ||
      url.pathname === '/xrpc/zone.stratos.identity.resolveEnrollments' ||
      url.pathname === '/xrpc/zone.stratos.enrollment.status' ||
      url.pathname === '/xrpc/zone.stratos.admin.getRepoHost' ||
      url.pathname === '/xrpc/zone.stratos.admin.addBoundary' ||
      url.pathname === '/xrpc/zone.stratos.admin.removeBoundary'
    )
      return handleMembership(route, url)
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
    page.getByRole('link', { name: '← All boundaries', exact: true }),
  ).toBeVisible()
  await page.goto(
    'http://127.0.0.1:6174/#/boundaries/detail?boundary=did%3Aweb%3Anerv.test%2Fpilots&tab=settings',
  )
  await expect(page).toHaveURL(/tab=settings/)
  await expect(page.getByTestId('boundary-detail')).toContainText('Pilots')
  await expect(
    page.getByRole('link', { name: '← All boundaries', exact: true }),
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
    .getByRole('link', { name: 'Edit', exact: true })
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
  await row('Pilots').getByRole('link', { name: 'Edit', exact: true }).click()
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Pilot operations')
  const beforeReviewWrites = mutations.length
  await page
    .getByLabel('Display name', { exact: true })
    .fill('  Pilot operations  ')
  await page.getByLabel('Description', { exact: true }).fill('Misato policy')
  await page.getByLabel('Show in the public room directory').uncheck()
  await page.getByLabel('Allow members to join').uncheck()
  await page.getByLabel('Add new enrollments automatically').check()
  await page.getByLabel('App access', { exact: true }).selectOption('open')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  const expectedSettings = {
    displayName: 'Pilot operations',
    description: 'Misato policy',
    listed: false,
    joinable: false,
    autoEnroll: true,
    appAccess: 'open',
    clientIds: [],
  }
  expect(
    JSON.parse(await page.getByTestId('settings-after').textContent()),
  ).toEqual(expectedSettings)
  expect(
    JSON.parse(await page.getByTestId('settings-before').textContent()),
  ).toMatchObject({
    displayName: 'Pilots',
    appAccess: 'allowList',
    clientIds: ['https://spike.test/client'],
  })
  await page.getByRole('button', { name: 'Cancel review', exact: true }).click()
  expect(mutations).toHaveLength(beforeReviewWrites)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await page
    .getByLabel('Description', { exact: true })
    .fill('Misato revised policy')
  await expect(page.getByTestId('settings-preview')).toHaveCount(0)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  const retainedRefreshPreview = await page
    .getByTestId('settings-preview')
    .textContent()
  for (const fault of ['500', 'network']) {
    settingsRefreshFault = fault
    const beforeRefreshReads = catalogRequests.length
    await page
      .getByRole('button', { name: 'Refresh catalog', exact: true })
      .click()
    await expect(page.getByRole('alert')).toContainText(
      'catalog could not be refreshed',
    )
    await expect(page.getByLabel('Description', { exact: true })).toHaveValue(
      'Misato revised policy',
    )
    expect(await page.getByTestId('settings-preview').textContent()).toBe(
      retainedRefreshPreview,
    )
    await page
      .getByRole('button', { name: 'Retry loading', exact: true })
      .click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(catalogRequests).toHaveLength(beforeRefreshReads + 2)
    await expect(page.getByLabel('Description', { exact: true })).toHaveValue(
      'Misato revised policy',
    )
    expect(await page.getByTestId('settings-preview').textContent()).toBe(
      retainedRefreshPreview,
    )
    expect(mutations).toHaveLength(beforeReviewWrites)
  }
  catalog = catalog.map((item) =>
    item.roomId === 'pilots' ? { ...item, revision: item.revision + 1 } : item,
  )
  await page
    .getByRole('button', { name: 'Refresh catalog', exact: true })
    .click()
  await expect(page.getByTestId('settings-preview')).toHaveCount(0)
  expect(mutations).toHaveLength(beforeReviewWrites)
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Pilot operations')
  conflictNext = true
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm save', exact: true }).click()
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
  const writesBeforeConflictRefresh = mutations.length
  await page
    .getByRole('button', { name: 'Refresh catalog', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Refresh catalog', exact: true }),
  ).toBeEnabled()
  await expect(page.getByRole('alert')).toContainText(
    'Your form values are still here',
  )
  await expect(page.getByLabel('Display name', { exact: true })).toHaveValue(
    'Pilot operations',
  )
  expect(mutations).toHaveLength(writesBeforeConflictRefresh)
  await page.getByRole('link', { name: 'Overview', exact: true }).click()
  await expect(page.getByTestId('navigation-confirmation')).toBeVisible()
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(page.getByTestId('boundary-overview')).toBeVisible()
  await expect(page.getByTestId('boundary-detail')).toContainText(
    'Pilots — updated by Rei',
  )
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(mutations).toHaveLength(writesBeforeConflictRefresh)
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Pilot operations')
  await page
    .getByLabel('Description', { exact: true })
    .fill('Misato revised policy')
  await page.getByLabel('Show in the public room directory').uncheck()
  await page.getByLabel('Allow members to join').uncheck()
  await page.getByLabel('Add new enrollments automatically').check()
  await page.getByLabel('App access', { exact: true }).selectOption('open')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  const writesBeforeDoubleConfirm = mutations.length
  await page
    .getByRole('button', { name: 'Confirm save', exact: true })
    .evaluate((button) => {
      button.click()
      button.click()
    })
  await expect(page.getByRole('status')).toContainText(
    'Pilot operations saved.',
  )
  await page.getByRole('link', { name: '← All boundaries' }).click()
  expect(mutations).toHaveLength(writesBeforeDoubleConfirm + 1)
  expect(mutations.at(-1).body.revision).toBe(3)
  expect(mutations.at(-1).body.settings).toEqual({
    ...expectedSettings,
    description: 'Misato revised policy',
  })
  await row('Pilot operations')
    .getByRole('link', { name: 'Edit', exact: true })
    .click()
  await page.getByLabel('Display name', { exact: true }).fill('Pilot recovery')
  conflictNext = true
  failConflictReload = true
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm save', exact: true }).click()
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
  await page.getByRole('button', { name: 'Confirm save', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Pilot recovery saved.')
  catalog = catalog.map((item) =>
    item.roomId === 'pilots'
      ? {
          ...item,
          description: 'Rei revised this policy',
          revision: item.revision + 1,
        }
      : item,
  )
  await page
    .getByRole('button', { name: 'Refresh catalog', exact: true })
    .click()
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue(
    'Rei revised this policy',
  )
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeEnabled()
  await page.getByRole('link', { name: '← All boundaries' }).click()
  await row('Pilot recovery')
    .getByRole('link', { name: 'Deactivate', exact: true })
    .click()
  const beforeLateDraft = mutations.length
  await page.getByRole('button', { name: 'Deactivate', exact: true }).click()
  await expect(page.getByTestId('deactivation-confirmation')).toBeVisible()
  await page
    .getByLabel('Description', { exact: true })
    .fill('Draft entered after confirmation opened')
  await page
    .getByRole('button', { name: 'Remove members and deactivate', exact: true })
    .click()
  await expect(page.getByRole('alertdialog')).toContainText(
    'Discard unsaved settings',
  )
  expect(mutations).toHaveLength(beforeLateDraft)
  await page
    .getByRole('button', { name: 'Review settings', exact: true })
    .click()
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue(
    'Draft entered after confirmation opened',
  )
  await expect(page.getByTestId('deactivation-confirmation')).toHaveCount(0)
  expect(mutations).toHaveLength(beforeLateDraft)
  await page
    .getByLabel('Description', { exact: true })
    .fill('Unsaved lifecycle draft')
  const beforeLifecycle = mutations.length
  await page.getByRole('button', { name: 'Deactivate', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toContainText(
    'Discard unsaved settings',
  )
  await page
    .getByRole('button', { name: 'Review settings', exact: true })
    .click()
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue(
    'Unsaved lifecycle draft',
  )
  await page.getByRole('button', { name: 'Deactivate', exact: true }).click()
  await page
    .getByRole('button', { name: 'Discard settings and continue', exact: true })
    .click()
  expect(mutations).toHaveLength(beforeLifecycle)
  await expect(page.getByTestId('deactivation-confirmation')).toContainText(
    'All 2 members will be removed',
  )
  await expect(page.getByTestId('deactivation-confirmation')).toContainText(
    'Records and the boundary name will be retained',
  )
  await page
    .getByRole('button', { name: 'Remove members and deactivate', exact: true })
    .click()
  await expect(page.getByTestId('boundary-lifecycle')).toContainText(
    'Removing members: 2 remaining',
  )
  await expect(
    page.getByTestId('boundary-detail').getByText('Inactive', { exact: true }),
  ).toBeVisible({ timeout: 10000 })
  await page.getByRole('button', { name: 'Reactivate', exact: true }).click()
  await expect(
    page.getByTestId('boundary-detail').getByText('Active', { exact: true }),
  ).toBeVisible()
  await page
    .getByLabel('Description', { exact: true })
    .fill('Queued while leaving')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByTestId('settings-preview')).toBeVisible()
  const writesBeforeSave = mutations.length
  let releaseSave
  saveGate = new Promise((resolve) => {
    releaseSave = resolve
  })
  await page.getByRole('button', { name: 'Confirm save', exact: true }).click()
  await page.getByRole('link', { name: 'Members', exact: true }).click()
  await expect(page.getByTestId('navigation-confirmation')).toContainText(
    'A save is still in progress.',
  )
  await page.getByRole('button', { name: 'Stay', exact: true }).click()
  await expect(page.getByTestId('navigation-confirmation')).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: 'Members', exact: true }),
  ).toBeFocused()
  releaseSave()
  saveGate = null
  await expect(page.getByRole('status')).toContainText('saved.')
  expect(mutations).toHaveLength(writesBeforeSave + 1)
  await page.getByRole('link', { name: '← All boundaries' }).click()
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
  await row('Bebop').getByRole('link', { name: 'Edit', exact: true }).click()
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
    'http://127.0.0.1:6174/#/boundaries/detail?boundary=did%3Aweb%3Anerv.test%2Fpilots&tab=members',
  )
  await expect(page.getByTestId('boundary-members')).toBeVisible()
  await expect(page.getByTestId('boundary-members')).toContainText(
    'Catalog members: 2',
  )
  await expect(page.getByTestId('boundary-members')).toContainText(
    'Loaded rows: 2',
  )
  paginationCursor = 'next-page'
  pendingListFilter = new Promise((resolve) => {
    releasePendingListFilter = resolve
  })
  const activeFilterGate = pendingListFilter
  const activeFilterStarted = new Promise((resolve) =>
    pendingFilterStarted.push(resolve),
  )
  await page.getByLabel('Enrollment status').selectOption('active')
  await activeFilterStarted
  expect(typeof releasePendingListFilter).toBe('function')
  await expect(page.getByRole('status')).toContainText('Loading members')
  await page.getByLabel('Enrollment status').selectOption('')
  await expect(page.getByTestId('boundary-members')).toContainText(
    'Loaded rows: 1',
  )
  expect(
    new URLSearchParams(membershipRequests.at(-1).search).has('active'),
  ).toBe(false)
  await expect(page.getByTestId('boundary-members')).not.toContainText(
    'Filtered total: 1',
  )
  releasePendingListFilter()
  await expect(page.getByTestId('boundary-members')).toContainText(
    'Loaded rows: 1',
  )
  expect(
    new URLSearchParams(membershipRequests.at(-1).search).has('active'),
  ).toBe(false)
  expect(
    new URLSearchParams(membershipRequests.at(-1).search).get('boundary'),
  ).toBe('did:web:nerv.test/pilots')
  await page.getByRole('button', { name: 'Load more', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Member page unavailable')
  expect(
    new URLSearchParams(membershipRequests.at(-1).search).get('cursor'),
  ).toBe('next-page')
  await expect(page.getByTestId('boundary-members')).toContainText(
    'Loaded rows: 1',
  )
  await page.getByRole('button', { name: 'Retry page', exact: true }).click()
  await expect(page.getByTestId('boundary-members')).toContainText(
    'Loaded rows: 2',
  )
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(
    new URLSearchParams(membershipRequests.at(-1).search).get('cursor'),
  ).toBe('next-page')
  await page.getByLabel('Enrollment status').selectOption('')
  await page.getByLabel('Custody').selectOption('stratos')
  await expect
    .poll(() =>
      new URLSearchParams(membershipRequests.at(-1).search).get('custody'),
    )
    .toBe('stratos')
  expect(membershipRequests.at(-1)).toMatchObject({
    pathname: '/xrpc/zone.stratos.admin.listEnrollments',
    method: 'GET',
  })
  expect(
    new URLSearchParams(membershipRequests.at(-1).search).get('limit'),
  ).toBe('25')
  expect(
    new URLSearchParams(membershipRequests.at(-1).search).get('boundary'),
  ).toBe('did:web:nerv.test/pilots')
  expect(
    new URLSearchParams(membershipRequests.at(-1).search).has('cursor'),
  ).toBe(false)
  expect(
    new URLSearchParams(membershipRequests.at(-1).search).has('active'),
  ).toBe(false)
  expect(
    new URLSearchParams(membershipRequests.at(-1).search).get('custody'),
  ).toBe('stratos')
  await page.getByLabel('DID or handle').fill('did:plc:shin')
  await page.getByRole('button', { name: 'Look up', exact: true }).click()
  await expect(page.getByTestId('boundary-member-lookup')).toContainText(
    'This boundary: Member',
  )
  await expect(page.getByTestId('boundary-member-lookup')).not.toContainText(
    'Loading enrollment',
  )
  await page
    .getByRole('button', { name: 'Remove from this boundary', exact: true })
    .click()
  await expect(page.getByTestId('membership-preview')).toContainText(
    'Other boundary memberships are unchanged',
  )
  const previewReadCount = enrollmentReads.length
  enrollmentState.get('did:plc:shin').boundaries = enrollmentState
    .get('did:plc:shin')
    .boundaries.filter((item) => item !== 'did:web:nerv.test/pilots')
  await page
    .getByRole('button', { name: 'Confirm change', exact: true })
    .click()
  await expect(page.getByRole('status')).toContainText('state changed')
  expect(membershipMutations).toHaveLength(0)
  expect(enrollmentReads.length).toBeGreaterThan(previewReadCount)
  enrollmentState
    .get('did:plc:shin')
    .boundaries.push('did:web:nerv.test/pilots')
  expect(membershipMutations).toHaveLength(0)
  await page.getByLabel('DID or handle').fill('did:plc:rei')
  await page.getByRole('button', { name: 'Look up', exact: true }).click()
  await expect(page.getByText('Enrollment: Inactive')).toBeVisible()
  await page
    .getByRole('button', { name: 'Add to this boundary', exact: true })
    .click()
  await expect(page.getByTestId('membership-preview')).toContainText(
    'This enrollment is inactive. Membership does not activate it.',
  )
  await page
    .getByRole('button', { name: 'Confirm change', exact: true })
    .dblclick()
  await expect(page.getByText(/Membership change saved/)).toBeVisible()
  expect(membershipMutations).toHaveLength(1)
  expect(membershipMutations[0]).toEqual({
    method: 'addBoundary',
    verb: 'POST',
    body: { did: 'did:plc:rei', boundary: 'did:web:nerv.test/pilots' },
  })
  expect(enrollmentState.get('did:plc:rei').active).toBe(false)
  await page
    .getByRole('button', { name: 'Remove from this boundary', exact: true })
    .click()
  await expect(page.getByTestId('membership-preview')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Confirm change', exact: true }),
  ).toBeEnabled()
  await page
    .getByRole('button', { name: 'Confirm change', exact: true })
    .click()
  await expect.poll(() => membershipMutations.length).toBe(2)
  await expect(
    page.getByRole('status').filter({ hasText: 'Membership change saved' }),
  ).toBeVisible()
  expect(membershipMutations).toHaveLength(2)
  expect(membershipMutations[1]).toEqual({
    method: 'removeBoundary',
    verb: 'POST',
    body: { did: 'did:plc:rei', boundary: 'did:web:nerv.test/pilots' },
  })
  expect(enrollmentState.get('did:plc:rei').boundaries).toEqual([
    'did:web:nerv.test/people',
  ])
  await page.getByLabel('DID or handle').fill('did:plc:unenrolled')
  await page.getByRole('button', { name: 'Look up', exact: true }).click()
  await expect(
    page.getByText('This page cannot create or invite an enrollment.'),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Add to this boundary', exact: true }),
  ).toHaveCount(0)
  expect(
    mutations.some(({ method }) =>
      ['setBoundaries', 'setActive', 'createEnrollment'].includes(method),
    ),
  ).toBe(false)

  await page.getByLabel('DID or handle').fill('did:plc:rei')
  await page.getByRole('button', { name: 'Look up', exact: true }).click()
  await expect(page.getByTestId('boundary-member-lookup')).toContainText(
    'This boundary: Not a member',
  )
  membershipFault = 'deferred'
  await page
    .getByRole('button', { name: 'Add to this boundary', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Confirm change', exact: true })
    .click()
  await expect(page.getByRole('status')).toContainText('saved locally')
  expect(membershipMutations).toHaveLength(3)
  expect(membershipMutations[2]).toEqual({
    method: 'addBoundary',
    verb: 'POST',
    body: { did: 'did:plc:rei', boundary: 'did:web:nerv.test/pilots' },
  })

  await page
    .getByRole('button', { name: 'Remove from this boundary', exact: true })
    .click()
  contradictoryMembership = true
  await page
    .getByRole('button', { name: 'Confirm change', exact: true })
    .click()
  await expect(page.getByRole('status')).toContainText('not as requested')
  expect(membershipMutations).toHaveLength(4)
  expect(enrollmentState.get('did:plc:rei').boundaries).toContain(
    'did:web:nerv.test/pilots',
  )

  await page
    .getByRole('button', { name: 'Remove from this boundary', exact: true })
    .click()
  failCatalogAfterMembershipSave = true
  await page
    .getByRole('button', { name: 'Confirm change', exact: true })
    .click()
  await expect(page.getByRole('alert')).toContainText(
    'catalog could not be refreshed',
  )
  await expect(
    page.getByText('The catalog could not be refreshed.', { exact: true }),
  ).toBeVisible()
  expect(membershipMutations).toHaveLength(5)
  expect(enrollmentState.get('did:plc:rei').boundaries).not.toContain(
    'did:web:nerv.test/pilots',
  )

  await expect(page.getByRole('alert')).toContainText(
    'catalog could not be refreshed',
  )
  expect(membershipMutations).toHaveLength(5)
  expect(enrollmentState.get('did:plc:rei').boundaries).not.toContain(
    'did:web:nerv.test/pilots',
  )
  await page.getByRole('button', { name: 'Retry loading', exact: true }).click()
  await expect(page.getByTestId('boundary-members')).toBeVisible()
  await page.getByLabel('DID or handle').fill('did:plc:rei')
  await page.getByRole('button', { name: 'Look up', exact: true }).click()
  await expect(page.getByTestId('boundary-member-lookup')).toContainText(
    'This boundary: Not a member',
  )
  await page
    .getByRole('button', { name: 'Add to this boundary', exact: true })
    .click()
  membershipFault = '500-no-save'
  await page
    .getByRole('button', { name: 'Confirm change', exact: true })
    .click()
  await expect(page.getByText(/The result is uncertain/)).toBeVisible()
  expect(membershipMutations).toHaveLength(6)
  await expect(
    page.getByRole('button', { name: 'Retry reconciliation' }),
  ).toBeVisible()
  listFailure = '503'
  await page.getByRole('button', { name: 'Retry reconciliation' }).click()
  await expect(page.getByRole('status')).toContainText(
    'Reconciliation is incomplete',
  )
  await expect(
    page.getByRole('button', { name: 'Retry reconciliation' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Add to this boundary', exact: true }),
  ).toBeDisabled()
  expect(membershipMutations).toHaveLength(6)
  await page.getByRole('button', { name: 'Retry reconciliation' }).click()
  await expect(
    page.getByText('Reconciliation confirms this membership is absent.'),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Add to this boundary', exact: true }),
  ).toBeEnabled()
  expect(membershipMutations).toHaveLength(6)
  await page
    .getByRole('button', { name: 'Add to this boundary', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Confirm change', exact: true })
    .click()
  await expect.poll(() => membershipMutations.length).toBe(7)
  await expect(page.getByRole('status')).toContainText(
    'Membership change saved',
  )
  expect(enrollmentState.get('did:plc:rei').boundaries).toContain(
    'did:web:nerv.test/pilots',
  )

  await page
    .getByRole('button', { name: 'Remove from this boundary', exact: true })
    .click()
  membershipFault = 'drop-no-save'
  await page
    .getByRole('button', { name: 'Confirm change', exact: true })
    .click()
  await expect(page.getByText(/The result is uncertain/)).toBeVisible()
  expect(membershipMutations).toHaveLength(8)
  expect(enrollmentState.get('did:plc:rei').boundaries).toContain(
    'did:web:nerv.test/pilots',
  )
  await expect(
    page.getByRole('button', { name: 'Retry reconciliation' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Retry reconciliation' }).click()
  await expect(
    page.getByText('Reconciliation confirms this membership is present.'),
  ).toBeVisible()
  await expect(
    page.getByRole('button', {
      name: 'Remove from this boundary',
      exact: true,
    }),
  ).toBeEnabled()
  expect(membershipMutations).toHaveLength(8)

  for (const status of [401, 403]) {
    authFault = String(status)
    await page
      .getByRole('button', { name: 'Remove from this boundary', exact: true })
      .click()
    await page
      .getByRole('button', { name: 'Confirm change', exact: true })
      .click()
    await expect(page.getByTestId('admin-shell')).toHaveCount(0)
    await expect(page.getByTestId('login-screen')).toBeVisible()
    expect(membershipMutations.at(-1)).toEqual({
      method: 'removeBoundary',
      verb: 'POST',
      body: { did: 'did:plc:rei', boundary: 'did:web:nerv.test/pilots' },
    })
    await page.reload()
    await expect(page.getByTestId('admin-shell')).toContainText('did:plc:spike')
    await expect(page.getByTestId('boundary-members')).toBeVisible()
    await page.getByLabel('DID or handle').fill('did:plc:rei')
    await page.getByRole('button', { name: 'Look up', exact: true }).click()
    await expect(page.getByTestId('boundary-member-lookup')).toContainText(
      'This boundary: Member',
    )
  }

  const pilots = 'did:web:nerv.test/pilots'
  const lookupCard = page.getByTestId('boundary-member-lookup')
  const action = (name) => page.getByRole('button', { name, exact: true })
  const selectTarget = async (did) => {
    await page.getByLabel('DID or handle').fill(did)
    await action('Look up').click()
    await expect(lookupCard).not.toContainText('Loading enrollment')
    await expect(lookupCard).toContainText(
      did === 'rei.example' ? 'did:plc:rei' : did,
    )
  }
  const navigateMembers = async (boundary) => {
    await page.evaluate(
      (value) => {
        window.location.hash = value
      },
      '#/boundaries/detail?boundary=' +
        encodeURIComponent(boundary) +
        '&tab=members',
    )
    await expect(page).toHaveURL((url) =>
      url.hash.includes(encodeURIComponent(boundary)),
    )
    await expect(page.getByTestId('boundary-members')).toBeVisible()
  }
  const holdRequest = async (suffix, did) => {
    let release
    let started
    let delivered
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const reached = new Promise((resolve) => {
      started = resolve
    })
    const done = new Promise((resolve) => {
      delivered = resolve
    })
    const pattern = '**/xrpc/' + suffix + '**'
    const handler = async (route) => {
      const url = new URL(route.request().url())
      if (did && url.searchParams.get('did') !== did) return route.fallback()
      await page.unroute(pattern, handler)
      started()
      await gate
      await route.fallback()
      delivered()
    }
    await page.route(pattern, handler)
    return { reached, release, done }
  }
  await selectTarget('did:plc:rei')
  await action('Remove from this boundary').click()
  await action('Confirm change').click()
  await expect(
    page.getByText('Membership change saved.', { exact: true }),
  ).toBeVisible()
  let expectedWrites = membershipMutations.length
  for (const [operation, fault, present] of [
    ['Add to this boundary', '500', true],
    ['Remove from this boundary', 'drop', false],
  ]) {
    await selectTarget('did:plc:rei')
    membershipFault = fault
    await action(operation).click()
    await action('Confirm change').click()
    await expect(page.getByText(/The result is uncertain/)).toBeVisible()
    expectedWrites++
    expect(membershipMutations).toHaveLength(expectedWrites)
    expect(membershipMutations.at(-1)).toEqual({
      method: present ? 'addBoundary' : 'removeBoundary',
      verb: 'POST',
      body: { did: 'did:plc:rei', boundary: pilots },
    })
    expect(enrollmentState.get('did:plc:rei').boundaries.includes(pilots)).toBe(
      present,
    )
    await expect(action(operation)).toBeDisabled()
    await page.getByRole('link', { name: 'Overview', exact: true }).click()
    await page.getByRole('link', { name: 'Members', exact: true }).click()
    await selectTarget('did:plc:rei')
    await expect(action(operation)).toBeDisabled()
    listFailure = '503'
    await page.getByRole('button', { name: 'Retry reconciliation' }).click()
    await expect(page.getByText(/Reconciliation is incomplete/)).toBeVisible()
    await expect(action(operation)).toBeDisabled()
    expect(membershipMutations).toHaveLength(expectedWrites)
    await page.getByRole('button', { name: 'Retry reconciliation' }).click()
    await expect(
      page.getByText(
        'Reconciliation confirms this membership is ' +
          (present ? 'present.' : 'absent.'),
      ),
    ).toBeVisible()
    expect(membershipMutations).toHaveLength(expectedWrites)
  }
  for (const suffix of [
    'zone.stratos.identity.resolveEnrollments',
    'zone.stratos.enrollment.status',
    'zone.stratos.admin.getRepoHost',
  ]) {
    const held = await holdRequest(suffix, 'did:plc:rei')
    await page.getByLabel('DID or handle').fill('did:plc:rei')
    await action('Look up').click()
    await held.reached
    await selectTarget('did:plc:service')
    await expect(lookupCard).toContainText('Account: Service account')
    held.release()
    await held.done
    await expect(lookupCard).toContainText('Target: did:plc:service')
    await expect(lookupCard).toContainText('Enrollment: Active')
    await expect(lookupCard).toContainText('Account: Service account')
  }
  for (const switchContext of [
    'target',
    'filter',
    'boundary',
    'health',
    'enrollments',
  ]) {
    await navigateMembers(pilots)
    await selectTarget('did:plc:rei')
    await action('Add to this boundary').click()
    const held = await holdRequest(
      'zone.stratos.enrollment.status',
      'did:plc:rei',
    )
    await action('Confirm change').click()
    await held.reached
    if (switchContext === 'target') await selectTarget('did:plc:service')
    if (switchContext === 'filter')
      await page.getByLabel('Enrollment status').selectOption('active')
    if (switchContext === 'boundary')
      await navigateMembers('did:web:nerv.test/people')
    if (switchContext === 'health' || switchContext === 'enrollments') {
      await page
        .getByRole('navigation', { name: 'Administration' })
        .getByRole('link', {
          name: switchContext === 'health' ? 'Health' : 'Enrollments',
          exact: true,
        })
        .click()
      await expect(page.getByTestId('boundary-members')).toHaveCount(0)
    }
    held.release()
    await held.done
    await expect(page.getByTestId('membership-preview')).toHaveCount(0)
    expect(membershipMutations).toHaveLength(expectedWrites)
  }
  for (const switchContext of [
    'target',
    'filter',
    'boundary',
    'health',
    'enrollments',
  ]) {
    await navigateMembers(pilots)
    await selectTarget('did:plc:rei')
    await action('Add to this boundary').click()
    const held = await holdRequest('zone.stratos.admin.addBoundary')
    membershipFault = '500'
    await action('Confirm change').click()
    await held.reached
    if (switchContext === 'target') await selectTarget('did:plc:service')
    if (switchContext === 'filter')
      await page.getByLabel('Enrollment status').selectOption('inactive')
    if (switchContext === 'boundary')
      await navigateMembers('did:web:nerv.test/people')
    if (switchContext === 'health' || switchContext === 'enrollments') {
      await page
        .getByRole('navigation', { name: 'Administration' })
        .getByRole('link', {
          name: switchContext === 'health' ? 'Health' : 'Enrollments',
          exact: true,
        })
        .click()
      await expect(page.getByTestId('boundary-members')).toHaveCount(0)
    }
    if (switchContext === 'health' || switchContext === 'enrollments') {
      await navigateMembers(pilots)
      await selectTarget('did:plc:rei')
      await expect(action('Add to this boundary')).toBeDisabled()
      await expect(
        page.getByRole('button', { name: 'Retry reconciliation' }),
      ).toBeDisabled()
      expect(membershipMutations).toHaveLength(expectedWrites)
    }
    held.release()
    await held.done
    expectedWrites++
    await expect.poll(() => membershipMutations.length).toBe(expectedWrites)
    if (switchContext === 'health' || switchContext === 'enrollments') {
      await expect(
        page.getByRole('button', { name: 'Retry reconciliation' }),
      ).toBeEnabled()
      await page
        .getByRole('navigation', { name: 'Administration' })
        .getByRole('link', {
          name: switchContext === 'health' ? 'Health' : 'Enrollments',
          exact: true,
        })
        .click()
      await expect(page.getByTestId('boundary-members')).toHaveCount(0)
    } else {
      await expect(lookupCard).not.toContainText('Membership change saved')
    }
    await navigateMembers(pilots)
    await selectTarget('did:plc:rei')
    await expect(action('Remove from this boundary')).toBeDisabled()
    await page.getByRole('button', { name: 'Retry reconciliation' }).click()
    await expect(
      page.getByText('Reconciliation confirms this membership is present.'),
    ).toBeVisible()
    await action('Remove from this boundary').click()
    await action('Confirm change').click()
    expectedWrites++
    await expect(
      page.getByText('Membership change saved.', { exact: true }),
    ).toBeVisible()
    expect(membershipMutations).toHaveLength(expectedWrites)
  }
  await selectTarget('did:plc:rei')
  await action('Add to this boundary').click()
  enrollmentState
    .get('did:plc:rei')
    .boundaries.push('did:web:nerv.test/services')
  await action('Confirm change').click()
  expectedWrites++
  await expect(
    page.getByText('Membership change saved.', { exact: true }),
  ).toBeVisible()
  expect(enrollmentState.get('did:plc:rei').boundaries).toEqual([
    'did:web:nerv.test/people',
    'did:web:nerv.test/services',
    pilots,
  ])
  expect(membershipMutations).toHaveLength(expectedWrites)
  expect(membershipMutations.at(-1)).toEqual({
    method: 'addBoundary',
    verb: 'POST',
    body: { did: 'did:plc:rei', boundary: pilots },
  })

  await page.route(
    'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=rei.example',
    (route) => route.fulfill({ json: { did: 'did:plc:rei' } }),
  )
  await selectTarget('rei.example')
  await expect(lookupCard).toContainText('Target: did:plc:rei')
  for (const suffix of [
    'zone.stratos.enrollment.status',
    'zone.stratos.admin.getRepoHost',
  ]) {
    await page.route('**/xrpc/' + suffix + '**', async (route) => {
      await page.unroute('**/xrpc/' + suffix + '**')
      await route.fulfill({
        status: 503,
        json: { error: 'Unavailable', message: 'Optional detail unavailable.' },
      })
    })
    await selectTarget('did:plc:rei')
    await expect(lookupCard).toContainText('unknown')
    if (suffix.endsWith('.status'))
      await expect(action('Remove from this boundary')).toBeDisabled()
    else await expect(lookupCard).not.toContainText('Custody: stratos')
  }
  await selectTarget('did:plc:rei')
  await action('Remove from this boundary').click()
  await page.route(
    '**/xrpc/zone.stratos.enrollment.status**',
    async (route) => {
      await page.unroute('**/xrpc/zone.stratos.enrollment.status**')
      await route.fulfill({
        status: 503,
        json: { error: 'Unavailable', message: 'Required detail unavailable.' },
      })
    },
  )
  await action('Confirm change').click()
  await expect(page.getByText(/Required fresh reads failed/)).toBeVisible()
  expect(membershipMutations).toHaveLength(expectedWrites)
  await selectTarget('did:plc:rei')
  await action('Remove from this boundary').click()
  const refreshHeld = await holdRequest('zone.stratos.admin.listEnrollments')
  await action('Confirm change').click()
  await refreshHeld.reached
  await selectTarget('did:plc:service')
  refreshHeld.release()
  await refreshHeld.done
  expectedWrites++
  await expect(lookupCard).toContainText('Target: did:plc:service')
  await expect(lookupCard).not.toContainText('Membership change saved')
  expect(membershipMutations).toHaveLength(expectedWrites)
  await selectTarget('did:plc:rei')
  await action('Add to this boundary').click()
  const inflight = await holdRequest('zone.stratos.admin.addBoundary')
  await action('Confirm change').click()
  await inflight.reached
  await page.getByLabel('Custody').selectOption('pds')
  await selectTarget('did:plc:rei')
  await expect(action('Add to this boundary')).toBeDisabled()
  await expect(
    page.getByRole('button', { name: 'Retry reconciliation' }),
  ).toBeDisabled()
  inflight.release()
  await inflight.done
  expectedWrites++
  await expect(action('Add to this boundary')).toBeEnabled()
  await expect(
    page.getByRole('button', { name: 'Retry reconciliation' }),
  ).toHaveCount(0)
  expect(membershipMutations).toHaveLength(expectedWrites)
  await action('Add to this boundary').click()
  await action('Confirm change').click()
  await expect(page.getByText(/state changed/)).toBeVisible()
  expect(membershipMutations).toHaveLength(expectedWrites)
  await expect(action('Remove from this boundary')).toBeEnabled()
  expect(enrollmentState.get('did:plc:rei').boundaries).toContain(
    'did:web:nerv.test/services',
  )
  await action('Remove from this boundary').click()
  const sameDidWrite = await holdRequest('zone.stratos.admin.removeBoundary')
  await action('Confirm change').click()
  await sameDidWrite.reached
  await selectTarget('did:plc:rei')
  await expect(action('Remove from this boundary')).toBeDisabled()
  sameDidWrite.release()
  await sameDidWrite.done
  expectedWrites++
  await expect(action('Remove from this boundary')).toBeEnabled()
  await expect(
    page.getByRole('button', { name: 'Retry reconciliation' }),
  ).toHaveCount(0)
  expect(membershipMutations).toHaveLength(expectedWrites)
  expect(membershipMutations.at(-1)).toEqual({
    method: 'removeBoundary',
    verb: 'POST',
    body: { did: 'did:plc:rei', boundary: pilots },
  })
  await page.getByLabel('DID or handle').focus()
  await page.keyboard.press('Tab')
  await expect(action('Look up')).toBeFocused()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)

  const reservedBoundary = 'did:web:nerv.test/general'
  await page.goto(
    'http://127.0.0.1:6174/#/boundaries/detail?boundary=did%3Aweb%3Anerv.test%2Fgeneral&tab=members',
  )
  await expect(page.getByTestId('boundary-members')).toBeVisible()
  await page.getByLabel('DID or handle').fill('did:plc:shin')
  await page.getByRole('button', { name: 'Look up', exact: true }).click()
  await expect(page.getByTestId('boundary-member-lookup')).toContainText(
    'This boundary: Not a member',
  )
  await expect(
    page.getByRole('button', { name: 'Add to this boundary', exact: true }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Add to this boundary', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Confirm change', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(membershipMutations).toHaveLength(expectedWrites)
  enrollmentState.get('did:plc:shin').boundaries.push(reservedBoundary)
  await page.getByLabel('DID or handle').fill('did:plc:shin')
  await page.getByRole('button', { name: 'Look up', exact: true }).click()
  await expect(page.getByTestId('boundary-member-lookup')).toContainText(
    'This boundary: Member',
  )
  await page
    .getByRole('button', { name: 'Remove from this boundary', exact: true })
    .click()
  await expect(page.getByRole('status')).toContainText(
    'reserved all-members boundary cannot be changed',
  )
  await expect(page.getByTestId('membership-preview')).toHaveCount(0)
  expect(membershipMutations).toHaveLength(expectedWrites)
  enrollmentState.get('did:plc:shin').boundaries = enrollmentState
    .get('did:plc:shin')
    .boundaries.filter((item) => item !== reservedBoundary)
  const inactiveBoundary = catalog.find(
    (item) => item.boundary === 'did:web:nerv.test/archive',
  )
  inactiveBoundary.status = 'deactivating'
  enrollmentState.get('did:plc:shin').boundaries.push(inactiveBoundary.boundary)
  await page.goto(
    'http://127.0.0.1:6174/#/boundaries/detail?boundary=did%3Aweb%3Anerv.test%2Farchive&tab=members',
  )
  await expect(page.getByTestId('boundary-members')).toBeVisible()
  await page.getByLabel('DID or handle').fill('did:plc:shin')
  await page.getByRole('button', { name: 'Look up', exact: true }).click()
  await expect(page.getByTestId('boundary-member-lookup')).not.toContainText(
    'Loading enrollment',
  )
  await expect(page.getByTestId('boundary-member-lookup')).toContainText(
    'This boundary: Member',
  )
  await expect(
    page.getByText('Only active boundaries accept new memberships.'),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Add to this boundary', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', {
      name: 'Remove from this boundary',
      exact: true,
    }),
  ).toBeEnabled()
  await page
    .getByRole('button', { name: 'Remove from this boundary', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Confirm change', exact: true })
    .click()
  await expect(page.getByRole('status')).toContainText(
    'Membership change saved',
  )
  expect(membershipMutations.at(-1)).toEqual({
    method: 'removeBoundary',
    verb: 'POST',
    body: { did: 'did:plc:shin', boundary: inactiveBoundary.boundary },
  })
  expect(membershipMutations).toHaveLength(expectedWrites + 1)
  await page.goto(
    'http://127.0.0.1:6174/#/boundaries/detail?boundary=did%3Aweb%3Anerv.test%2F' +
      'archive-'.repeat(16) +
      'long-id&tab=overview',
  )
  await expect(page.getByTestId('boundary-detail')).toContainText(
    'Long identifier boundary',
  )
  await page.getByRole('link', { name: '← All boundaries' }).focus()
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
  catalog = catalog.map((boundary) =>
    boundary.roomId === 'pilots'
      ? { ...boundary, status: 'deactivating' }
      : boundary,
  )
  await page.clock.install()
  await page.goto('http://127.0.0.1:6174/' + overviewHref)
  await expect(page.getByTestId('boundary-overview')).toContainText(
    'Removing members',
  )
  const overviewNode = await page
    .getByTestId('boundary-overview')
    .elementHandle()
  const overviewLink = page.getByRole('link', { name: 'Overview', exact: true })
  const focusedNode = await overviewLink.elementHandle()
  await overviewLink.focus()
  let releasePoll
  deferredPoll = new Promise((resolve) => {
    releasePoll = resolve
  })
  const beforePoll = catalogRequests.length
  await page.clock.fastForward(3_000)
  await expect.poll(() => catalogRequests.length).toBe(beforePoll + 1)
  await expect(page.getByTestId('boundary-overview')).toBeVisible()
  expect(
    await overviewNode.evaluate(
      (node) =>
        node === document.querySelector('[data-testid="boundary-overview"]'),
    ),
  ).toBe(true)
  expect(
    await focusedNode.evaluate((node) => node === document.activeElement),
  ).toBe(true)
  catalog = catalog.map((boundary) =>
    boundary.roomId === 'pilots'
      ? { ...boundary, status: 'inactive', memberCount: 0 }
      : boundary,
  )
  releasePoll()
  await expect(page.getByTestId('boundary-overview')).toContainText('Inactive')
  expect(
    await overviewNode.evaluate(
      (node) =>
        node === document.querySelector('[data-testid="boundary-overview"]'),
    ),
  ).toBe(true)
  expect(
    await focusedNode.evaluate((node) => node === document.activeElement),
  ).toBe(true)
  deferredPoll = null
  await page.clock.resume()
  await page.getByRole('link', { name: '← All boundaries' }).click()
  const acceptedHash =
    '#/boundaries/detail?boundary=did%3Aweb%3Anerv.test%2Fpilots&tab=settings'
  const writesBeforeGuard = mutations.length
  async function dirtyEditor() {
    if (await page.getByTestId('boundary-settings').count()) {
      await page.getByRole('link', { name: '← All boundaries' }).click()
    }
    await row('Pilot recovery')
      .getByRole('link', { name: 'Edit', exact: true })
      .click()
    await page
      .getByLabel('Display name', { exact: true })
      .fill('  Misato draft  ')
    await page
      .getByRole('button', { name: 'Save changes', exact: true })
      .click()
    await expect(page.getByTestId('settings-preview')).toBeVisible()
  }
  async function retainedDraft() {
    await expect(page.getByTestId('navigation-confirmation')).toHaveCount(1)
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toBe(acceptedHash)
    await expect(page.getByTestId('boundary-editor')).toBeVisible()
    await page.getByRole('button', { name: 'Stay', exact: true }).click()
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue(
      '  Misato draft  ',
    )
    await expect(page.getByTestId('settings-preview')).toContainText(
      'Misato draft',
    )
  }
  await page.getByRole('link', { name: 'Health', exact: true }).click()
  await page.reload()
  await page.getByRole('link', { name: 'Boundaries', exact: true }).click()
  await expect(page.getByTestId('boundaries-screen')).toBeVisible()
  await page.evaluate(() =>
    window.history.replaceState(
      { ...window.history.state, crew: { captain: 'Misato' } },
      '',
    ),
  )
  const entryBeforeReload = await page.evaluate(() => window.history.state)
  await page.reload()
  await expect(page.getByTestId('boundaries-screen')).toBeVisible()
  let reloadHistoryLength = await page.evaluate(() => window.history.length)
  let documentsAfterReload = 0
  const countDocuments = (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      documentsAfterReload++
    }
  }
  page.on('request', countDocuments)
  await dirtyEditor()
  reloadHistoryLength = await page.evaluate(() => window.history.length)
  const reloadPreview = await page.getByTestId('settings-preview').textContent()
  await page.evaluate(() => window.history.back())
  await retainedDraft()
  expect(await page.getByTestId('settings-preview').textContent()).toBe(
    reloadPreview,
  )
  expect(await page.evaluate(() => window.history.state.crew)).toEqual(
    entryBeforeReload.crew,
  )
  for (let traversal = 0; traversal < 3; traversal++) {
    await page.evaluate(() => window.history.back())
    await expect(page.getByTestId('navigation-confirmation')).toHaveCount(1)
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toBe(acceptedHash)
    await page.evaluate(() => window.history.forward())
    await expect(page.getByTestId('navigation-confirmation')).toHaveCount(1)
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toBe(acceptedHash)
  }
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toBe('#/boundaries')
  await expect(page.getByTestId('boundary-settings')).toHaveCount(0)
  await expect(page.getByTestId('navigation-confirmation')).toHaveCount(0)
  await page.evaluate(() => window.history.forward())
  await expect(page.getByTestId('boundary-settings')).toBeVisible()
  await expect(page.getByLabel('Display name', { exact: true })).toHaveValue(
    'Pilot recovery',
  )
  await expect(page.getByTestId('navigation-confirmation')).toHaveCount(0)
  expect(await page.evaluate(() => window.history.state.crew)).toEqual(
    entryBeforeReload.crew,
  )
  expect(await page.evaluate(() => window.history.length)).toBe(
    reloadHistoryLength,
  )
  expect(documentsAfterReload).toBe(0)
  page.off('request', countDocuments)
  await page.evaluate(() =>
    window.history.replaceState(
      {
        ...window.history.state,
        crew: 'Misato',
        __svelte_spa_router_scrollX: 23,
      },
      '',
    ),
  )
  await dirtyEditor()
  await page.getByRole('link', { name: 'Health', exact: true }).click()
  await retainedDraft()
  expect(await page.evaluate(() => window.history.state.crew)).toBe('Misato')
  await page.getByTestId('logout').click()
  await retainedDraft()
  await page.getByRole('link', { name: 'Members', exact: true }).click()
  await retainedDraft()
  await page.getByRole('link', { name: 'Overview', exact: true }).click()
  await retainedDraft()
  await page.getByRole('link', { name: '← All boundaries' }).click()
  await retainedDraft()

  for (const hash of [
    '#/boundaries?catalog=attempt',
    '#/boundaries/detail?boundary=did%3Aweb%3Anerv.test%2Farchive&tab=settings',
  ]) {
    await page.evaluate((hash) => {
      window.location.hash = hash
    }, hash)
    await retainedDraft()
  }
  await page.evaluate(() => window.history.back())
  await expect(page.getByTestId('navigation-confirmation')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toBe(acceptedHash)
  for (let traversal = 0; traversal < 3; traversal++) {
    await page.evaluate(() => window.history.forward())
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toBe(acceptedHash)
    await expect(page.getByTestId('navigation-confirmation')).toHaveCount(1)
  }
  await retainedDraft()
  await page.evaluate(() => window.history.forward())
  await expect(page.getByTestId('navigation-confirmation')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toBe(acceptedHash)
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(page.getByTestId('boundary-detail')).toContainText('Archive')
  await expect(page.getByTestId('navigation-confirmation')).toHaveCount(0)
  await page.getByRole('link', { name: '← All boundaries' }).click()
  await dirtyEditor()
  await page.getByRole('link', { name: 'Health', exact: true }).click()
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(page.getByTestId('boundary-editor')).toHaveCount(0)
  await page.getByRole('link', { name: 'Boundaries', exact: true }).click()
  for (const tab of ['Members', 'Overview']) {
    await dirtyEditor()
    await page.getByRole('link', { name: tab, exact: true }).click()
    await page.getByRole('button', { name: 'Discard', exact: true }).click()
    await expect(
      page.getByTestId(
        tab === 'Members' ? 'boundary-members' : 'boundary-overview',
      ),
    ).toBeVisible()
    await page.getByRole('link', { name: '← All boundaries' }).click()
  }
  await dirtyEditor()
  await page.getByRole('link', { name: '← All boundaries' }).click()
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(page.getByTestId('boundaries-screen')).toBeVisible()
  await dirtyEditor()
  await page.getByTestId('logout').click()
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(page.getByTestId('admin-shell')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('admin-shell')).toBeVisible()
  await page.getByRole('link', { name: 'Boundaries', exact: true }).click()
  await expect(page.getByTestId('boundaries-screen')).toBeVisible()
  await page.getByTestId('create-boundary').click()
  await expect(page.getByTestId('boundary-editor')).toBeVisible()
  await row('Pilot recovery')
    .getByRole('link', { name: 'Edit', exact: true })
    .click()
  await expect(page.getByTestId('boundary-settings')).toBeVisible()
  await page.getByRole('link', { name: '← All boundaries' }).click()
  await expect(page.getByTestId('boundaries-screen')).toBeVisible()
  await expect(page.getByTestId('boundary-editor')).toBeVisible()
  await page.getByLabel('Display name', { exact: true }).fill('Misato draft')
  await page.getByRole('link', { name: 'Health', exact: true }).click()
  await expect(page.getByTestId('navigation-confirmation')).toHaveCount(1)
  await page.getByRole('button', { name: 'Stay', exact: true }).click()
  await expect(page.getByLabel('Display name', { exact: true })).toHaveValue(
    'Misato draft',
  )
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByTestId('boundary-editor')).toHaveCount(0)
  await dirtyEditor()
  await page.route('**/xrpc/zone.stratos.admin.listBoundaries*', (route) =>
    route.fulfill({ status: 401, json: { error: 'AuthRequired' } }),
  )
  await page
    .getByRole('button', { name: 'Refresh catalog', exact: true })
    .click()
  await expect(page.getByTestId('admin-shell')).toHaveCount(0)
  await expect(page.getByTestId('navigation-confirmation')).toHaveCount(0)
  expect(mutations).toHaveLength(writesBeforeGuard)
  expect(errors).toEqual([])
  log(
    JSON.stringify({
      status: 'PASS',
      mutations: mutations.length,
      membershipWrites: membershipMutations.length,
      checks: [
        'persisted add 500 and persisted remove dropped response; no automatic replay',
        'failed reconciliation blocks reentry until required reads succeed',
        'deterministic lookup, status and custody target races',
        'target, filter, boundary, Health and Enrollments switches during deferred writes',
        'cross-route pending and uncertain operation retention',
        'same-DID pending relookup success releases actions without another lookup',
        'settled deactivating boundary hides Add and permits existing membership removal',
        'unrelated concurrent membership retained',
        'domains route alias',
        'reserved boundary constraints',
        'create exact XRPC payload',
        'conflict preserves draft and reloads revision',
        'mutation conflict does not hide successfully loaded detail',
        'catalog refresh preserves mutation recovery feedback',
        'deferred detail poll preserves DOM identity and focus',
        'conflict reload failure and retry',
        'late lifecycle draft requires explicit discard or review with zero writes',
        'settings catalog 500 and network refresh show retry and retain draft and preview',
        'deactivate confirmation',
        'deactivating progress polling',
        'reactivate empty',
        'members link',
        'load failure and retry',
        'no delete control',
        '390px without overflow',
        'desktop/mobile/dark screenshots',
        'membership list filters, cursor retry and query scoping',
        'pre-confirm membership drift blocks writes',
        'inactive enrollment membership without activation',
        'membership add/remove exact payload and single-write double-click guard',
        'un-enrolled lookup does not expose enrollment creation',
        'reload retains history stamp and unrelated state keys',
        'reload dirty preview Back Stay preserves exact URL, draft and preview',
        'repeated traversal and Discard reach Health without reload or history growth',
        'settings save in flight warns and restores focus to the workspace',
        'create draft keeps its guard after a Settings visit',
        'refresh adopts boundary data and rebases a clean settings form',
        'no browser exceptions',
      ],
    }),
  )
} finally {
  await browser.close()
}
