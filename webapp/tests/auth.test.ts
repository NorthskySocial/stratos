/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
// Import AFTER mocking
import {
  getSession,
  getSpaceWriteScopeStatus,
  init,
  SPACE_WRITE_SCOPE,
  onSessionDeleted,
  signIn,
  signOut,
} from '../src/lib/auth'
import { BrowserOAuthClient } from '@atproto/oauth-client-browser'

// We need a variable for onSessionDeleted captured from constructor
let capturedOnDelete: ((sub: string, cause: string) => void) | null = null
let mockInstance: unknown = null

vi.mock('@atproto/oauth-client-browser', () => {
  const BrowserOAuthClient = vi.fn().mockImplementation(function (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: any,
  ) {
    capturedOnDelete = options.onSessionDeleted
    this.init = vi.fn().mockResolvedValue({ session: null })
    this.signIn = vi.fn().mockResolvedValue(undefined)
    this.revoke = vi.fn().mockResolvedValue(undefined)
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    mockInstance = this
  })
  // Ensure it's treated as a constructor by Vitest/ESM
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(BrowserOAuthClient as any).prototype = {}
  return { BrowserOAuthClient }
})

describe('auth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('init sets session on success', async () => {
    const mockSession = { sub: 'did:user' }

    // We already have a mockInstance if it was called during module load
    // But we want to control the next call to init()
    const mockInit = vi.fn().mockResolvedValue({ session: mockSession })

    // We can't easily re-instantiate if it's already cached in auth.ts
    // Let's see if we can just mock the existing instance's init
    if (mockInstance) {
      ;(mockInstance as { init: unknown }).init = mockInit
    } else {
      vi.mocked(BrowserOAuthClient).mockImplementationOnce(function (
        this: { init: unknown; signIn: unknown; revoke: unknown },
        options: { onSessionDeleted: (sub: string, cause: string) => void },
      ) {
        capturedOnDelete = options.onSessionDeleted
        this.init = mockInit
        this.signIn = vi.fn()
        this.revoke = vi.fn()
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        mockInstance = this
      } as unknown as typeof BrowserOAuthClient)
    }

    const session = await init()
    expect(session).toEqual(mockSession)
    expect(getSession()).toEqual(mockSession)
  })

  it('signIn calls client.signIn', async () => {
    await init() // ensures client exists

    const mockSignIn = vi.fn().mockResolvedValue(undefined)
    if (mockInstance) {
      ;(mockInstance as { signIn: unknown }).signIn = mockSignIn
    }

    await signIn('user.test')

    expect(mockSignIn).toHaveBeenCalledWith('user.test', expect.any(Object))
  })

  it('signOut clears session', async () => {
    // Setup session manually if possible or via init
    await signOut()
    expect(getSession()).toBeNull()
  })

  it('calls sessionDeletedCallback when session is deleted', async () => {
    const callback = vi.fn()
    onSessionDeleted(callback)

    // Ensure client is created
    await init()

    if (capturedOnDelete) {
      capturedOnDelete('did:user', 'cause')
    }

    expect(callback).toHaveBeenCalled()
    expect(getSession()).toBeNull()
  })

  it('distinguishes a missing space scope from a scope lookup failure', async () => {
    const missing = await getSpaceWriteScopeStatus({
      getTokenInfo: vi
        .fn()
        .mockResolvedValue({ scope: 'atproto transition:generic' }),
    } as never)
    const unavailable = await getSpaceWriteScopeStatus({
      getTokenInfo: vi
        .fn()
        .mockRejectedValue(new Error('Nadia cannot reach the token endpoint')),
    } as never)
    const granted = await getSpaceWriteScopeStatus({
      getTokenInfo: vi.fn().mockResolvedValue({ scope: SPACE_WRITE_SCOPE }),
    } as never)

    expect(missing).toBe('missing')
    expect(unavailable).toBe('unavailable')
    expect(granted).toBe('granted')
  })

  it('uses a canonical, encoded scope for a port-bearing service DID', async () => {
    vi.stubEnv('VITE_STRATOS_SERVICE_DID', 'did:web:localhost%3A3100')
    vi.resetModules()
    const { getSpaceWriteScopeStatus, SPACE_WRITE_SCOPE } =
      await import('../src/lib/auth')
    const getTokenInfo = vi.fn().mockResolvedValue({ scope: SPACE_WRITE_SCOPE })

    expect(SPACE_WRITE_SCOPE).toBe(
      'space:zone.stratos.space.feed?authority=did%3Aweb%3Alocalhost%253A3100&collection=zone.stratos.feed.post&action=read&action=create',
    )
    await expect(
      getSpaceWriteScopeStatus({ getTokenInfo } as never),
    ).resolves.toBe('granted')
    expect(getTokenInfo).toHaveBeenCalledWith(false)
    await expect(
      getSpaceWriteScopeStatus({
        getTokenInfo: vi.fn().mockResolvedValue({
          scope: SPACE_WRITE_SCOPE.replace(
            'action=read&action=create',
            'action=create&action=read',
          ),
        }),
      } as never),
    ).resolves.toBe('missing')
    vi.unstubAllEnvs()
  })

  it('uses the default handle resolver when the build argument is empty', async () => {
    vi.stubEnv('VITE_ATPROTO_HANDLE_RESOLVER', '')
    vi.resetModules()
    const auth = await import('../src/lib/auth')

    await auth.init()

    expect(BrowserOAuthClient).toHaveBeenLastCalledWith(
      expect.objectContaining({
        handleResolver: 'https://bsky.social',
        allowHttp: true,
        clientMetadata: expect.objectContaining({
          scope: expect.stringContaining(SPACE_WRITE_SCOPE),
        }),
      }),
    )
    vi.unstubAllEnvs()
  })

  it('keeps the loopback redirect URI stable during an OAuth callback', async () => {
    window.history.replaceState({}, '', '/?code=Masami&state=Fuu')
    vi.resetModules()
    const auth = await import('../src/lib/auth')

    await auth.init()

    expect(BrowserOAuthClient).toHaveBeenLastCalledWith(
      expect.objectContaining({
        clientMetadata: expect.objectContaining({
          redirect_uris: ['http://127.0.0.1:3000/'],
        }),
      }),
    )
    window.history.replaceState({}, '', '/')
  })
})
