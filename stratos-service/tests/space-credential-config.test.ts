import { afterEach, describe, expect, it, vi } from 'vitest'
import { envToConfig, parseEnv } from '../src/config.js'

const saved = process.env

afterEach(() => {
  process.env = saved
  vi.restoreAllMocks()
})

function configure(overrides: Record<string, string> = {}) {
  process.env = {
    STRATOS_SERVICE_DID: 'did:web:nerv.test',
    ...overrides,
  }
  return envToConfig(parseEnv()).stratos
}

describe('space credential lifetimes', () => {
  it('keeps separate legacy and HTTP signature defaults', () => {
    const config = configure()
    expect(config.spaceCredentialTtlSeconds).toBe(7_200)
    expect(config.spaceHttpCredentialTtlSeconds).toBe(600)
  })

  it.each(['1', '3600'])(
    'accepts bounded HTTP lifetime %s independently',
    (ttl) => {
      const config = configure({
        STRATOS_SPACE_CREDENTIAL_TTL_SECONDS: '86400',
        STRATOS_SPACE_HTTP_CREDENTIAL_TTL_SECONDS: ttl,
      })
      expect(config.spaceCredentialTtlSeconds).toBe(86_400)
      expect(config.spaceHttpCredentialTtlSeconds).toBe(Number(ttl))
    },
  )

  it.each(['0', '-1', '3601', '1.5', 'NaN', 'Infinity', ''])(
    'rejects invalid HTTP lifetime %s',
    (ttl) => {
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit')
      })
      vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(() =>
        configure({ STRATOS_SPACE_HTTP_CREDENTIAL_TTL_SECONDS: ttl }),
      ).toThrow('exit')
      expect(exit).toHaveBeenCalledWith(1)
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('STRATOS_SPACE_HTTP_CREDENTIAL_TTL_SECONDS'),
      )
    },
  )
})
