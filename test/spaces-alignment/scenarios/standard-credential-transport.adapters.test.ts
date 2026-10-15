import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  mkdir: vi.fn(),
  execFileSync: vi.fn(),
  launch: vi.fn(),
  require: vi.fn(),
  createRequire: vi.fn(),
  delays: [] as number[],
  deadline: 0,
}))
vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
  mkdir: mocks.mkdir,
}))
vi.mock('node:child_process', () => ({ execFileSync: mocks.execFileSync }))
vi.mock('node:module', () => ({ createRequire: mocks.createRequire }))
vi.mock('node:timers/promises', () => ({
  setTimeout: async (ms: number) => {
    mocks.delays.push(ms)
    vi.setSystemTime(
      mocks.deadline && Date.now() < mocks.deadline
        ? Math.min(Date.now() + ms, mocks.deadline)
        : Date.now() + ms,
    )
  },
}))

const domain = 'bebop.test'
const clubhouse = 'https://clubhouse-e2e.atmosbox.internal'
const authority = 'https://stratos-e2e.atmosbox.internal'
const pds = `https://october-pds-e2e.${domain}`
const space = `at://did:web:stratos-e2e.${domain}/space/zone.stratos.space.feed/general`
let driver: typeof import('./standard-credential-transport.driver.mjs')
beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  mocks.delays.length = 0
  mocks.deadline = 0
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  vi.stubEnv('SANDBOX_DOMAIN', domain)
  vi.stubEnv('HOME', '/home/faye')
  mocks.readFile.mockImplementation(async (file: string) => {
    if (file === '/ca/root.crt') return Buffer.from('public test certificate')
    if (file === '/run/sandbox-secrets/browser-password') return ' swordfish \n'
    if (file === '/run/sandbox-secrets/october-admin-password')
      return ' redtail \n'
    throw new Error(`Unexpected fixture file ${file}`)
  })
  mocks.require.mockReturnValue({ chromium: { launch: mocks.launch } })
  mocks.createRequire.mockReturnValue(mocks.require)
  driver = await import('./standard-credential-transport.driver.mjs')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function pageFixture(fault = '', join = false) {
  if (fault === 'timeout') mocks.deadline = 1_060_000
  const events: unknown[][] = []
  let oauth = 0
  let composer = false
  let checks = 0
  let composerWaits = 0
  let text = ''
  let reloading = false
  let session: unknown = { fetchHandler: vi.fn() }
  const record = { repo: 'did:plc:faye', space, record: { text: '' } }
  const seed = { uri: 'at://faye/post/rei', cid: 'bafyrei' }
  const locator = (selector: string): any => ({
    first: () => locator(selector),
    count: async () => 3,
    nth: (index: number) => {
      expect(index).toBeLessThan(3)
      return locator(`${selector}::${index}`)
    },
    isVisible: async () => {
      events.push(['visible', selector])
      if (selector.includes('::0')) throw new Error('detached')
      if (selector.includes('::1')) return true
      if (selector.includes('::2'))
        return fault !== 'keyboard' && fault !== 'timeout'
      if (selector.includes('password')) {
        if (fault === 'password-detached') throw new Error('detached')
        return oauth === 1 && fault !== 'consent-only'
      }
      if (selector.includes('username')) {
        if (fault === 'username-detached') throw new Error('detached')
        return fault !== 'no-username'
      }
      if (selector === 'Sign out') {
        if (fault === 'sign-out-error') throw new Error('detached')
        return fault !== 'sign-out'
      }
      if (selector === 'Open room') return !join
      if (selector === 'Join room') return fault !== 'no-join'
      if (selector === '#room-post')
        return composer && fault !== 'composer-timeout'
      if (selector === 'Check room again') return fault !== 'reload'
      return true
    },
    isEnabled: async () =>
      !selector.includes('::1') && fault !== 'keyboard' && fault !== 'timeout',
    fill: async (value: string) => {
      if (selector.includes('username')) {
        expect(['no-username', 'username-detached']).not.toContain(fault)
        expect(value).toBe('faye.october-pds-e2e.bebop.test')
      }
      events.push(['fill', selector, value])
      if (selector === '#room-post') {
        text = value
        record.record.text = value
      }
    },
    click: async (options?: unknown) => {
      events.push(['click', selector, options])
      if (selector === 'Sign in' || selector === 'Join room') oauth = 1
      if (selector === 'Join room') expect(join).toBe(true)
      if (selector.includes('::')) {
        expect(selector.endsWith('::2')).toBe(true)
        expect(options).toEqual({ noWaitAfter: true, timeout: 2_000 })
        if (selector.includes('submit')) expect(oauth).toBe(1)
        else
          expect(oauth).toBe(
            fault === 'consent-only' || fault === 'password-detached' ? 1 : 2,
          )
        oauth = selector.includes('submit') ? 2 : 3
        if (fault === 'click-error') throw new Error('navigation')
      }
      if (selector === 'Open room')
        composer =
          fault !== 'recheck' &&
          fault !== 'recheck-twice' &&
          fault !== 'reload' &&
          fault !== 'composer-timeout'
      if (selector === 'Check room again') {
        expect(fault).not.toBe('reload')
        checks += 1
        composer = checks > 1 || fault !== 'recheck-twice'
      }
    },
    waitFor: async (options: unknown) => {
      events.push(['wait', selector, options])
      expect(options).toEqual({
        state: 'visible',
        timeout: selector === '#room-post' ? 5_000 : 30_000,
      })
      if (selector === '#room-post') {
        composerWaits += 1
        expect(reloading || checks > 0).toBe(true)
        reloading = false
      }
      if (
        selector === '#room-post' &&
        (!composer || fault === 'composer-timeout')
      ) {
        vi.setSystemTime(Date.now() + 5_000)
        throw new Error('not ready')
      }
    },
    textContent: async () =>
      fault === 'note-null'
        ? null
        : fault === 'note'
          ? 'signed in as ed'
          : 'faye.october-pds-e2e.bebop.test',
    getByRole: (role: string, options: { name: string }) => {
      expect(role).toBe('button')
      expect(['Open room', 'Join room']).toContain(options.name)
      return locator(options.name)
    },
  })
  const page = {
    locator: (selector: string, options?: unknown) => {
      if (selector === '#room-post' && fault === 'composer-timeout')
        expect(Date.now()).toBeLessThan(1_090_600)
      events.push(['locator', selector, options])
      expect([
        '#handle',
        '.signed-in-account',
        '.header-note',
        '.room-card',
        'a.room-link[href="/rooms/general"]',
        '#room-post',
        'input[name="password"], input[type="password"]',
        'input[name="username"]:not([readonly]):not([disabled]), input[name="identifier"]:not([readonly]):not([disabled])',
        'button[type="submit"], button:has-text("Sign in")',
        'button:has-text("Accept"), button:has-text("Authorize"), button:has-text("Allow")',
      ]).toContain(selector)
      if (selector === '.room-card')
        expect(options).toEqual({ has: expect.any(Object) })
      return locator(selector)
    },
    getByRole: (role: string, options: { name: string }) => {
      events.push(['role', role, options])
      expect(role).toBe('button')
      expect([
        'Sign in',
        'Sign out',
        'Check room again',
        'Post topic',
      ]).toContain(options.name)
      return locator(options.name)
    },
    goto: async (url: string, options: unknown) => {
      expect(url).toBe(clubhouse)
      expect(options).toEqual({ waitUntil: 'domcontentloaded' })
      events.push(['goto', url, options])
    },
    url: () => {
      if (fault === 'timeout') expect(Date.now()).toBeLessThan(1_060_000)
      if (fault === 'timeout') return clubhouse
      if (fault === 'source-origin') return 'https://impostor.test/callback'
      if (oauth >= 3) return clubhouse + '/callback'
      return oauth > 0 ? pds + '/oauth/authorize' : clubhouse
    },
    keyboard: {
      press: async (key: string) => {
        events.push(['key', key])
        oauth = 3
      },
    },
    reload: async (options: unknown) => {
      events.push(['reload', options])
      reloading = true
      composer = true
      if (fault === 'recheck-twice') composer = false
    },
    waitForResponse: (
      predicate: (response: any) => boolean,
      options: unknown,
    ) => {
      events.push(['response', options])
      const response = (method: string, url: string, ok: boolean) => ({
        request: () => ({ method: () => method }),
        url: () => url,
        ok: () => ok,
      })
      expect(
        predicate(
          response('GET', pds + '/xrpc/com.atproto.space.createRecord', true),
        ),
      ).toBe(false)
      expect(predicate(response('POST', pds + '/wrong', true))).toBe(false)
      expect(
        predicate(
          response('POST', pds + '/xrpc/com.atproto.space.createRecord', false),
        ),
      ).toBe(false)
      expect(
        predicate(
          response('POST', pds + '/xrpc/com.atproto.space.createRecord', true),
        ),
      ).toBe(true)
      return Promise.resolve({
        request: () => ({
          postDataJSON: () => ({
            ...record,
            ...(fault === 'repo' ? { repo: 'did:plc:ed' } : {}),
            ...(fault === 'space' ? { space: 'other' } : {}),
            ...(fault === 'seed-text' ? { record: { text: 'other' } } : {}),
          }),
        }),
        json: async () => ({
          ...seed,
          ...(fault === 'uri' ? { uri: null } : {}),
          ...(fault === 'cid' ? { cid: 4 } : {}),
        }),
      })
    },
    addScriptTag: async (options: unknown) => events.push(['script', options]),
    evaluate: async (fn: (arg: any) => unknown, arg?: unknown) => {
      const window = {
        ...(globalThis as any).window,
        delegationScenarioAuth: {
          init: async () => events.push(['init']),
          getSession: () => session,
        },
      }
      vi.stubGlobal('window', window)
      events.push(['evaluate', arg])
      return fn(arg)
    },
  }
  const browser = { newContext: async () => ({ newPage: async () => page }) }
  return {
    browser,
    page,
    events,
    seed,
    record,
    text: () => text,
    composerWaits: () => composerWaits,
    setSession: (value: unknown) => {
      session = value
    },
  }
}
function accountFetch(status = 200, fault = '') {
  const fetch = vi.fn(async (input: string, options: RequestInit) => {
    expect(options.method).toBe('POST')
    expect(new Headers(options.headers).get('content-type')).toBe(
      'application/json',
    )
    const body = JSON.parse(options.body as string)
    if (input.endsWith('.createSession')) {
      expect(input).toBe(pds + '/xrpc/com.atproto.server.createSession')
      expect(body).toEqual({
        identifier: 'faye.october-pds-e2e.bebop.test',
        password: 'swordfish',
      })
      return new Response(JSON.stringify({ did: 'did:plc:faye' }), { status })
    }
    if (input.endsWith('.createInviteCode')) {
      expect(input).toBe(pds + '/xrpc/com.atproto.server.createInviteCode')
      expect(new Headers(options.headers).get('authorization')).toBe(
        'Basic ' + Buffer.from('admin:redtail').toString('base64'),
      )
      expect(body).toEqual({ useCount: 1 })
      return new Response(
        JSON.stringify({ code: fault === 'code' ? 5 : 'ein' }),
        { status: fault === 'invite' ? 503 : 200 },
      )
    }
    expect(input).toBe(pds + '/xrpc/com.atproto.server.createAccount')
    expect(body).toEqual({
      email: 'faye@october-pds-e2e.bebop.test',
      handle: 'faye.october-pds-e2e.bebop.test',
      password: 'swordfish',
      inviteCode: 'ein',
    })
    return new Response(JSON.stringify({ did: 'did:plc:faye' }), {
      status: fault === 'create' ? 502 : 200,
    })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
describe('driver entrypoint', () => {
  it.each([[], ['node'], ['node', '/other.mjs']])(
    'does not execute on import with argv %j',
    async (...args) => {
      const run = vi.fn()
      await driver.main(args.flat(), run)
      expect(run).not.toHaveBeenCalled()
    },
  )
  it('prints only the successful receipt', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const receipt = { suite: 'rei', assertions: [] }
    const run = vi.fn().mockResolvedValue(receipt)
    await driver.main(
      [
        'node',
        new URL('./standard-credential-transport.driver.mjs', import.meta.url)
          .pathname,
      ],
      run,
    )
    expect(run).toHaveBeenCalledExactlyOnceWith()
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(receipt))
    log.mockRestore()
  })
  it.each([new TypeError('private detail'), 'private detail'])(
    'sanitizes main failure %#',
    async (error) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const previous = process.exitCode
      try {
        await driver.main(
          [
            'node',
            new URL(
              './standard-credential-transport.driver.mjs',
              import.meta.url,
            ).pathname,
          ],
          async () => {
            throw error
          },
        )
        expect(log).toHaveBeenCalledExactlyOnceWith(
          'Standard credential scenario failed: ' +
            (error instanceof Error ? 'TypeError' : 'UnknownError'),
        )
        expect(process.exitCode).toBe(1)
      } finally {
        process.exitCode = previous
        log.mockRestore()
      }
    },
  )
})

describe('real standard browser adapter bodies', () => {
  it.each([false, true])(
    'provisions, signs in, seeds and initializes auth (join=%s)',
    async (join) => {
      const fixture = pageFixture('', join)
      const fetch = accountFetch(join ? 401 : 200)
      const result = await driver.prepareAccount(fixture.browser, 'faye')
      expect(result).toEqual({
        account: {
          username: 'faye.october-pds-e2e.bebop.test',
          password: 'swordfish',
          did: 'did:plc:faye',
          seedText: fixture.text(),
        },
        page: fixture.page,
      })
      expect(fixture.text()).toMatch(/^Plan014 did:plc:faye [0-9a-f-]{36}$/)
      expect(fetch).toHaveBeenCalledTimes(join ? 3 : 1)
      expect(mocks.readFile).toHaveBeenCalledWith(
        '/run/sandbox-secrets/browser-password',
        'utf8',
      )
      expect(mocks.readFile).toHaveBeenCalledWith(
        '/run/sandbox-secrets/october-admin-password',
        'utf8',
      )
      expect(fixture.events).toContainEqual([
        'fill',
        'input[name="username"]:not([readonly]):not([disabled]), input[name="identifier"]:not([readonly]):not([disabled])',
        'faye.october-pds-e2e.bebop.test',
      ])
      expect(fixture.events.some((e) => e[0] === 'key')).toBe(false)
      expect(fixture.events).toContainEqual([
        'goto',
        clubhouse,
        { waitUntil: 'domcontentloaded' },
      ])
      expect(fixture.events).toContainEqual([
        'fill',
        '#handle',
        'faye.october-pds-e2e.bebop.test',
      ])
      expect(fixture.events).toContainEqual([
        'fill',
        'input[name="password"], input[type="password"]',
        'swordfish',
      ])
      expect(fixture.events).toContainEqual([
        'script',
        { path: '/scenario/auth-client.iife.js' },
      ])
      expect(fixture.events.at(-1)).toEqual(['init'])
      expect(mocks.delays).toEqual(join ? [300, 300, 300, 300] : [300, 300])
      expect(
        fixture.events.filter((e) => e[0] === 'click' && e[1] === 'Join room'),
      ).toHaveLength(join ? 1 : 0)
      expect((globalThis as any).window.delegationScenarioDomain).toBe(domain)
      expect(fixture.events).toContainEqual([
        'locator',
        'a.room-link[href="/rooms/general"]',
        undefined,
      ])
      expect(fixture.events).toContainEqual(['response', { timeout: 45_000 }])
      expect(fixture.events).toContainEqual([
        'wait',
        '.signed-in-account',
        { state: 'visible', timeout: 30_000 },
      ])
      expect(fixture.events).toContainEqual([
        'wait',
        '.room-card',
        { state: 'visible', timeout: 30_000 },
      ])
    },
  )
  it.each([
    'keyboard',
    'no-username',
    'username-detached',
    'password-detached',
    'consent-only',
    'click-error',
    'recheck',
    'reload',
    'recheck-twice',
  ])('handles browser transition %s', async (fault) => {
    accountFetch(400)
    const fixture = pageFixture(fault)
    await driver.prepareAccount(fixture.browser, 'faye')
    if (fault === 'keyboard')
      expect(fixture.events).toContainEqual(['key', 'Enter'])
    if (fault === 'no-username' || fault === 'username-detached')
      expect(
        fixture.events.some(
          (e) => e[0] === 'fill' && String(e[1]).includes('username'),
        ),
      ).toBe(false)
    if (fault === 'recheck') {
      expect(fixture.composerWaits()).toBe(1)
      expect(fixture.events.filter((e) => e[0] === 'reload')).toHaveLength(0)
      expect(fixture.events).toContainEqual([
        'wait',
        '#room-post',
        { state: 'visible', timeout: 5_000 },
      ])
    }
    if (fault === 'reload') {
      expect(fixture.composerWaits()).toBe(1)
    }
    if (fault === 'reload')
      expect(fixture.events).toContainEqual([
        'reload',
        { waitUntil: 'domcontentloaded' },
      ])
  })
  it.each([
    'note',
    'note-null',
    'sign-out',
    'sign-out-error',
    'no-join',
    'repo',
    'space',
    'seed-text',
    'uri',
    'cid',
    'timeout',
    'composer-timeout',
    'source-origin',
  ])('rejects invalid browser state %s', async (fault) => {
    accountFetch()
    const fixture = pageFixture(fault, fault === 'no-join')
    const messages: Record<string, string> = {
      note: 'Clubhouse did not hydrate the signed-in handle',
      'note-null': 'Clubhouse did not hydrate the signed-in handle',
      'sign-out': 'Clubhouse sign-in did not complete',
      'sign-out-error': 'Clubhouse sign-in did not complete',
      'no-join': 'Room general has no open or join action',
      timeout: 'OAuth callback did not complete',
      'source-origin': 'OAuth callback did not complete',
      'composer-timeout':
        'Room did not become ready after enrollment reconciliation',
    }
    await expect(
      driver.prepareAccount(fixture.browser, 'faye'),
    ).rejects.toThrow(messages[fault])
    if (fault === 'timeout') expect(Date.now()).toBe(1_060_000)
  })
  it.each([
    [500, '', 'PDS account lookup failed with HTTP 500'],
    [401, 'invite', 'PDS invite creation failed with HTTP 503'],
    [400, 'code', 'PDS invite response has no code'],
    [400, 'create', 'PDS account creation failed with HTTP 502'],
  ] as const)(
    'rejects provisioning failure %s/%s',
    async (status, fault, message) => {
      accountFetch(status, fault)
      await expect(
        driver.prepareAccount(pageFixture().browser, 'faye'),
      ).rejects.toThrow(message)
    },
  )
  it('loads Chromium only after installing the sandbox CA', async () => {
    const browser = {}
    mocks.launch.mockResolvedValue(browser)
    expect(await driver.openBrowser()).toBe(browser)
    expect(mocks.createRequire).toHaveBeenCalledWith(
      '/runner/feedgen-ng-e2e-browser.mjs',
    )
    expect(mocks.require).toHaveBeenCalledWith('playwright')
    expect(mocks.readFile).toHaveBeenCalledWith('/ca/root.crt')
    expect(mocks.mkdir).toHaveBeenCalledWith('/home/faye/.pki/nssdb', {
      recursive: true,
    })
    expect(mocks.execFileSync.mock.calls).toEqual([
      [
        'certutil',
        ['-N', '-d', 'sql:/home/faye/.pki/nssdb', '--empty-password'],
        { stdio: 'ignore' },
      ],
      [
        'certutil',
        [
          '-A',
          '-d',
          'sql:/home/faye/.pki/nssdb',
          '-n',
          'sandbox-ca',
          '-t',
          'C,,',
          '-i',
          '/ca/root.crt',
        ],
        { stdio: 'ignore' },
      ],
    ])
    expect(mocks.launch).toHaveBeenCalledWith({ headless: true })
    expect(mocks.execFileSync.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.launch.mock.invocationCallOrder[0],
    )
  })
  it('accepts an existing NSS database and uses the fallback HOME', async () => {
    vi.stubEnv('HOME', '')
    mocks.execFileSync.mockImplementationOnce(() => {
      throw new Error('already exists')
    })
    await driver.openBrowser()
    expect(mocks.mkdir).toHaveBeenCalledWith('/tmp/config/.pki/nssdb', {
      recursive: true,
    })
    expect(mocks.execFileSync).toHaveBeenCalledTimes(2)
    expect(mocks.launch).toHaveBeenCalledOnce()
  })
  it.each(['certificate', 'import'])(
    'does not launch after CA %s failure',
    async (fault) => {
      if (fault === 'certificate')
        mocks.readFile.mockRejectedValue(new Error('missing CA'))
      else
        mocks.execFileSync.mockImplementation((_: string, args: string[]) => {
          if (args[0] === '-A') throw new Error('import failed')
        })
      await expect(driver.openBrowser()).rejects.toThrow()
      expect(mocks.launch).not.toHaveBeenCalled()
    },
  )
  it.each(['bad/domain', '', undefined])(
    'rejects an invalid domain %s before loading Chromium',
    async (domain) => {
      vi.stubEnv('SANDBOX_DOMAIN', domain)
      vi.resetModules()
      const invalid = await import('./standard-credential-transport.driver.mjs')
      await expect(invalid.openBrowser()).rejects.toThrow()
      expect(mocks.createRequire).not.toHaveBeenCalled()
    },
  )
  it('requests the precise delegation and revoke operations inside page.evaluate', async () => {
    const fixture = pageFixture()
    const fetchHandler = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'delegation-rei' })),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    fixture.setSession({ fetchHandler })
    expect(await driver.acquireDelegation(fixture.page)).toBe('delegation-rei')
    expect(await driver.removeMember(fixture.page)).toBe(204)
    expect(fetchHandler.mock.calls).toEqual([
      [
        pds +
          '/xrpc/com.atproto.space.getDelegationToken?space=' +
          encodeURIComponent(space),
        { method: 'GET' },
      ],
      [authority + '/oauth/revoke', { method: 'POST' }],
    ])
  })
  it.each(['missing-session', 'status', 'token'])(
    'rejects delegation failure %s',
    async (fault) => {
      const fixture = pageFixture()
      fixture.setSession(
        fault === 'missing-session'
          ? null
          : {
              fetchHandler: async () =>
                new Response(JSON.stringify({ token: 42 }), {
                  status: fault === 'status' ? 403 : 200,
                }),
            },
      )
      await expect(driver.acquireDelegation(fixture.page)).rejects.toThrow(
        fault === 'missing-session'
          ? 'OAuth session is unavailable'
          : fault === 'status'
            ? 'PDS delegation request failed: 403'
            : 'PDS returned no delegation',
      )
    },
  )
  it('rejects removal without an OAuth session', async () => {
    const fixture = pageFixture()
    fixture.setSession(null)
    await expect(driver.removeMember(fixture.page)).rejects.toThrow(
      'OAuth session unavailable for removal',
    )
  })
})
