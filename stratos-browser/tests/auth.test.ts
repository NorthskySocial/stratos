import { beforeEach, describe, expect, it, vi } from 'vitest'

interface MockOAuthClientOptions {
  clientMetadata: {
    scope?: string
    redirect_uris?: string[]
  }
  onSessionDeleted: () => void
  fetch: typeof globalThis.fetch
  handleResolver: string
  allowHttp: boolean
}

let options: MockOAuthClientOptions | null = null
let client = {
  init: vi.fn(),
  signIn: vi.fn(),
  revoke: vi.fn(),
}

vi.mock('@atproto/oauth-client-browser', () => ({
  BrowserOAuthClient: vi.fn(function BrowserOAuthClient(
    nextOptions: MockOAuthClientOptions,
  ) {
    options = nextOptions
    return client
  }),
}))

import {
  buildSpaceWriteScope,
  createBrowserAuth,
  normalizeBrowserBaseUrl,
} from '../src/auth'

describe('createBrowserAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    options = null
    client = {
      init: vi.fn().mockResolvedValue({ session: null }),
      signIn: vi.fn().mockResolvedValue(undefined),
      revoke: vi.fn().mockResolvedValue(undefined),
    }
  })

  function createAuth(
    overrides: Partial<Parameters<typeof createBrowserAuth>[0]> = {},
  ) {
    return createBrowserAuth({
      appName: 'Clubhouse',
      scopes: ['atproto', 'repo:app.bsky.feed.post?action=create'],
      spaceWriteScope: { serviceDid: 'did:web:authority.test' },
      handleResolver: 'https://resolver.test',
      getBaseUrl: () => 'https://clubhouse.test/',
      isLoopback: () => false,
      ...overrides,
    })
  }

  it('builds the canonical, encoded Stratos space scope', () => {
    expect(
      buildSpaceWriteScope({ serviceDid: 'did:web:motoko.test%3A3100' }),
    ).toBe(
      'space:zone.stratos.space.feed?authority=did%3Aweb%3Amotoko.test%253A3100&collection=zone.stratos.feed.post&action=read&action=create',
    )
  })

  it('keeps factory configuration isolated and publishes injected metadata', async () => {
    const auth = createAuth()
    const otherAuth = createAuth({
      appName: 'Other',
      scopes: ['transition:generic'],
    })

    await auth.init()
    const firstOptions = options
    await otherAuth.init()

    expect(auth.scope).toContain(
      'space:zone.stratos.space.feed?authority=did%3Aweb%3Aauthority.test',
    )
    expect(firstOptions).toEqual(
      expect.objectContaining({
        handleResolver: 'https://resolver.test',
        allowHttp: false,
        clientMetadata: expect.objectContaining({
          client_name: 'Clubhouse',
          client_id: 'https://clubhouse.test/client-metadata.json',
          client_uri: 'https://clubhouse.test',
          redirect_uris: ['https://clubhouse.test/'],
          scope: auth.scope,
        }),
      }),
    )
    expect(otherAuth.scope).toContain('transition:generic')
  })

  it('uses loopback metadata and canonicalizes localhost redirects', async () => {
    const auth = createAuth({
      getBaseUrl: () => 'http://localhost:3000',
      isLoopback: () => true,
    })

    await auth.init()

    expect(options).toEqual(
      expect.objectContaining({
        allowHttp: true,
        clientMetadata: expect.objectContaining({
          redirect_uris: ['http://127.0.0.1:3000/'],
        }),
      }),
    )
  })

  it('routes resolver-origin OAuth requests through the injected proxy', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response())
    const auth = createAuth({
      oauthProxyUrl: 'https://proxy.test/oauth',
      fetch,
    })
    await auth.init()

    await options?.fetch(
      'https://resolver.test/xrpc/com.atproto.identity.resolveHandle?handle=fuu.test',
    )

    expect(fetch).toHaveBeenCalledWith(
      new URL(
        'https://proxy.test/oauth/xrpc/com.atproto.identity.resolveHandle?handle=fuu.test',
      ),
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('tracks restored and deleted sessions and reports scope lookup status', async () => {
    const session = {
      sub: 'did:plc:akira',
      getTokenInfo: vi
        .fn()
        .mockResolvedValue({ scope: 'atproto scope:granted' }),
    }
    client.init.mockResolvedValue({ session })
    const auth = createAuth()
    const deleted = vi.fn()
    auth.onSessionDeleted(deleted)

    await expect(auth.init()).resolves.toBe(session)
    await auth.signIn('fuu.test')
    expect(client.signIn).toHaveBeenCalledWith(
      'fuu.test',
      expect.objectContaining({ scope: auth.scope }),
    )
    await expect(
      auth.getScopeStatus(session as never, 'scope:granted'),
    ).resolves.toBe('granted')
    await expect(
      auth.getScopeStatus(session as never, 'scope:missing'),
    ).resolves.toBe('missing')
    session.getTokenInfo.mockRejectedValueOnce(new Error('unavailable'))
    await expect(
      auth.getScopeStatus(session as never, 'scope:granted'),
    ).resolves.toBe('unavailable')

    options?.onSessionDeleted()
    expect(auth.getSession()).toBeNull()
    expect(deleted).toHaveBeenCalledOnce()

    await auth.init()
    await auth.signOut()
    expect(client.revoke).toHaveBeenCalledWith('did:plc:akira')
    expect(auth.getSession()).toBeNull()
  })

  it('normalizes base URLs before paths are joined', () => {
    expect(normalizeBrowserBaseUrl('https://clubhouse.test///')).toBe(
      'https://clubhouse.test',
    )
  })
})
