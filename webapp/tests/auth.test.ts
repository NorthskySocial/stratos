/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
// Import AFTER mocking
import {
  getSession,
  init,
  onSessionDeleted,
  signIn,
  signOut,
} from '../src/lib/auth'
import { BrowserOAuthClient } from '@atproto/oauth-client-browser'

// We need a variable for onDelete captured from constructor
let capturedOnDelete: ((sub: string, cause: string) => void) | null = null
let mockInstance: unknown = null

vi.mock('@atproto/oauth-client-browser', () => {
  const BrowserOAuthClient = vi.fn().mockImplementation(function (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: any,
  ) {
    capturedOnDelete = options.onDelete
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
      vi.mocked(BrowserOAuthClient).mockImplementationOnce(
        function (this: { init: unknown; signIn: unknown; revoke: unknown }, options: { onDelete: (sub: string, cause: string) => void }) {
          capturedOnDelete = options.onDelete
          this.init = mockInit
          this.signIn = vi.fn()
          this.revoke = vi.fn()
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          mockInstance = this
        } as unknown as (options: { onDelete: (sub: string, cause: string) => void }) => void,
      )
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
})
