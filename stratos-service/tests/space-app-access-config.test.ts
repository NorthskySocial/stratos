/**
 * Config-parsing tests for the per-space app-access (client-attestation gating)
 * setting. Mirrors the service-enrollment config mechanism:
 * inline env + optional file JSON sources, boundary qualification, fail-fast.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spaceUriToBoundary } from '@northskysocial/stratos-core'
import { envToConfig, parseEnv } from '../src/config.js'
import { resolveAppAccess } from '../src/features/space-credential/app-access.js'
import { makeSpaceUri } from './helpers/space-uri.js'

const SERVICE_DID = 'did:web:host'
const BASE_ENV: Record<string, string> = {
  STRATOS_SERVICE_DID: SERVICE_DID,
  STRATOS_PUBLIC_URL: 'https://host.example.com',
  // 'general' is the default STRATOS_RESERVED_DOMAIN; envToConfig
  // asserts the reserved domain is within STRATOS_ALLOWED_DOMAINS at startup.
  STRATOS_ALLOWED_DOMAINS: 'general,eng,ops',
}
const CLIENT_ID = 'https://app.example/client-metadata.json'
const spaceUri = (skey: string) =>
  makeSpaceUri(SERVICE_DID, 'app.bsky.feed.generator', skey)
const boundaryFor = (skey: string) => {
  const result = spaceUriToBoundary(spaceUri(skey), SERVICE_DID)
  if (!result.ok) throw new Error(`bad test boundary: ${skey}`)
  return result.value
}

describe('space app-access config parsing', () => {
  let saved: NodeJS.ProcessEnv
  let tmp: string

  beforeEach(() => {
    saved = { ...process.env }
    tmp = mkdtempSync(join(tmpdir(), 'stratos-app-access-'))
  })
  afterEach(() => {
    process.env = saved
    rmSync(tmp, { recursive: true, force: true })
  })

  function setEnv(overrides: Record<string, string>): void {
    process.env = { ...BASE_ENV, ...overrides } as NodeJS.ProcessEnv
  }

  it('defaults to open (empty config) when unset', () => {
    setEnv({})
    const cfg = envToConfig(parseEnv())
    expect(cfg.stratos.spaceAppAccess.byBoundary.size).toBe(0)
    expect(
      resolveAppAccess(cfg.stratos.spaceAppAccess, boundaryFor('eng')).kind,
    ).toBe('open')
  })

  it('parses inline allowList and qualifies the space to a boundary', () => {
    setEnv({
      STRATOS_SPACE_APP_ACCESS: JSON.stringify([
        { space: 'eng', access: 'allowList', clientIds: [CLIENT_ID] },
      ]),
    })
    const cfg = envToConfig(parseEnv())
    const access = resolveAppAccess(
      cfg.stratos.spaceAppAccess,
      boundaryFor('eng'),
    )
    expect(access).toEqual({ kind: 'allowList', clientIds: [CLIENT_ID] })
    // A different (unconfigured) space stays open.
    expect(
      resolveAppAccess(cfg.stratos.spaceAppAccess, boundaryFor('ops')).kind,
    ).toBe('open')
  })

  it('parses an explicit open entry', () => {
    setEnv({
      STRATOS_SPACE_APP_ACCESS: JSON.stringify([
        { space: 'eng', access: 'open' },
      ]),
    })
    const cfg = envToConfig(parseEnv())
    expect(
      resolveAppAccess(cfg.stratos.spaceAppAccess, boundaryFor('eng')).kind,
    ).toBe('open')
  })

  it('parses from a file and merges with inline', () => {
    const file = join(tmp, 'access.json')
    writeFileSync(
      file,
      JSON.stringify([
        { space: 'ops', access: 'allowList', clientIds: [CLIENT_ID] },
      ]),
    )
    setEnv({
      STRATOS_SPACE_APP_ACCESS_FILE: file,
      STRATOS_SPACE_APP_ACCESS: JSON.stringify([
        { space: 'eng', access: 'allowList', clientIds: [CLIENT_ID] },
      ]),
    })
    const cfg = envToConfig(parseEnv())
    expect(cfg.stratos.spaceAppAccess.byBoundary.size).toBe(2)
  })

  it('rejects duplicate spaces across sources', () => {
    const file = join(tmp, 'access.json')
    writeFileSync(
      file,
      JSON.stringify([
        { space: 'eng', access: 'allowList', clientIds: [CLIENT_ID] },
      ]),
    )
    setEnv({
      STRATOS_SPACE_APP_ACCESS_FILE: file,
      STRATOS_SPACE_APP_ACCESS: JSON.stringify([
        { space: 'eng', access: 'open' },
      ]),
    })
    expect(() => envToConfig(parseEnv())).toThrow(/duplicate space app-access/)
  })

  it('rejects allowList without clientIds', () => {
    setEnv({
      STRATOS_SPACE_APP_ACCESS: JSON.stringify([
        { space: 'eng', access: 'allowList' },
      ]),
    })
    expect(() => envToConfig(parseEnv())).toThrow(/non-empty "clientIds"/)
  })

  it('rejects a non-HTTPS client_id in the allowList', () => {
    setEnv({
      STRATOS_SPACE_APP_ACCESS: JSON.stringify([
        {
          space: 'eng',
          access: 'allowList',
          clientIds: ['http://app.example/client-metadata.json'],
        },
      ]),
    })
    expect(() => envToConfig(parseEnv())).toThrow(/must be an https URL/)
  })

  it('rejects an invalid access discriminator', () => {
    setEnv({
      STRATOS_SPACE_APP_ACCESS: JSON.stringify([
        { space: 'eng', access: 'nope' },
      ]),
    })
    expect(() => envToConfig(parseEnv())).toThrow(/invalid "access"/)
  })

  it('rejects malformed JSON and names the inline source', () => {
    setEnv({ STRATOS_SPACE_APP_ACCESS: '{ not json' })
    expect(() => envToConfig(parseEnv())).toThrow(
      /STRATOS_SPACE_APP_ACCESS.*not valid JSON/s,
    )
  })

  it('rejects inline JSON that is not an array', () => {
    setEnv({ STRATOS_SPACE_APP_ACCESS: JSON.stringify({ space: 'eng' }) })
    expect(() => envToConfig(parseEnv())).toThrow(/must be a JSON array/)
  })
})
