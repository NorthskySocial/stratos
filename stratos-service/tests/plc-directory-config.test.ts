import { afterEach, describe, expect, it } from 'vitest'
import { envToConfig, parseEnv } from '../src/config.js'
import { trustedIdentityOrigins } from '../src/identity-resolver.js'

const savedEnv = { ...process.env }

afterEach(() => {
  process.env = { ...savedEnv }
})

function setEnv(overrides: Record<string, string>): void {
  process.env = {
    STRATOS_SERVICE_DID: 'did:web:nerv.jp',
    STRATOS_PUBLIC_URL: 'https://nerv.jp',
    STRATOS_ALLOWED_DOMAINS: 'general',
    ...overrides,
  }
}

describe('PLC directory configuration', () => {
  it('maps the private PLC policy independently from private identity origins', () => {
    setEnv({
      PLC_DIRECTORY: 'https://plc.nerv.jp',
      PLC_DIRECTORY_PRIVATE_CIDRS: '172.25.111.0/24',
      IDENTITY_PRIVATE_ORIGINS:
        'https://spaces-pds.nerv.jp,https://backup-pds.nerv.jp',
      IDENTITY_PRIVATE_CIDRS: '10.42.0.0/16,172.25.111.0/24',
    })

    const config = envToConfig(parseEnv())
    expect(config.identity.plcUrl).toBe('https://plc.nerv.jp')
    expect(trustedIdentityOrigins(config)).toEqual([
      { origin: 'https://plc.nerv.jp', privateCidrs: ['172.25.111.0/24'] },
      {
        origin: 'https://spaces-pds.nerv.jp',
        privateCidrs: ['10.42.0.0/16', '172.25.111.0/24'],
      },
      {
        origin: 'https://backup-pds.nerv.jp',
        privateCidrs: ['10.42.0.0/16', '172.25.111.0/24'],
      },
    ])
  })

  it('keeps a public PLC usable with no private policy', () => {
    setEnv({})
    const config = envToConfig(parseEnv())
    expect(config.identity.plcUrl).toBe('https://plc.directory')
    expect(trustedIdentityOrigins(config)).toEqual([])
  })

  it('requires a CIDR list for configured private identity origins', () => {
    setEnv({ IDENTITY_PRIVATE_ORIGINS: 'https://spaces-pds.nerv.jp' })
    expect(() => trustedIdentityOrigins(envToConfig(parseEnv()))).toThrow(
      'IDENTITY_PRIVATE_CIDRS is required',
    )
  })
})
