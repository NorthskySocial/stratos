import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { envToConfig, parseEnv } from '../src/config.js'

const BASE_ENV: Record<string, string> = {
  STRATOS_SERVICE_DID: 'did:web:host',
  STRATOS_PUBLIC_URL: 'https://host.example.com',
  STRATOS_ALLOWED_DOMAINS: 'eng,ops,general',
}

describe('boolean environment variables', () => {
  let saved: NodeJS.ProcessEnv

  beforeEach(() => {
    saved = { ...process.env }
  })

  afterEach(() => {
    process.env = saved
    vi.restoreAllMocks()
  })

  /** Replace process.env with BASE_ENV plus overrides. */
  function setEnv(overrides: Record<string, string>): void {
    process.env = { ...BASE_ENV, ...overrides } as NodeJS.ProcessEnv
  }

  it('reads STRATOS_DEV_MODE=false as false', () => {
    setEnv({ STRATOS_DEV_MODE: 'false' })

    expect(envToConfig(parseEnv()).stratos.devMode).toBe(false)
  })

  it('reads STRATOS_DEV_MODE=true as true', () => {
    setEnv({ STRATOS_DEV_MODE: 'true' })

    expect(envToConfig(parseEnv()).stratos.devMode).toBe(true)
  })

  it('leaves dev mode off when STRATOS_DEV_MODE is unset', () => {
    setEnv({})

    expect(envToConfig(parseEnv()).stratos.devMode).toBe(false)
  })

  it('reads STRATOS_DPOP_REQUIRE_NONCE=false as false', () => {
    setEnv({ STRATOS_DPOP_REQUIRE_NONCE: 'false' })

    expect(envToConfig(parseEnv()).dpop.requireNonce).toBe(false)
  })

  it('requires the DPoP nonce when the variable is unset', () => {
    setEnv({})

    expect(envToConfig(parseEnv()).dpop.requireNonce).toBe(true)
  })

  it('refuses a value that is neither true nor false', () => {
    setEnv({ STRATOS_DEV_MODE: '0' })
    // parseEnv reports the problem and exits, so stub the exit to observe it.
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit')
    }) as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => parseEnv()).toThrow('exit')
    expect(exit).toHaveBeenCalledWith(1)
  })
})
