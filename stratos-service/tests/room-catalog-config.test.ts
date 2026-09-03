import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { envToConfig, parseEnv } from '../src/config.js'

const BASE_ENV: Record<string, string> = {
  STRATOS_SERVICE_DID: 'did:web:host',
  STRATOS_PUBLIC_URL: 'https://host.example.com',
  STRATOS_ALLOWED_DOMAINS: 'general,nebula',
}

describe('room catalog configuration', () => {
  let savedEnvironment: NodeJS.ProcessEnv
  let temporaryDirectory: string

  beforeEach(() => {
    savedEnvironment = { ...process.env }
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'stratos-room-config-'))
  })

  afterEach(() => {
    process.env = savedEnvironment
    rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  function setEnvironment(overrides: Record<string, string>): void {
    process.env = { ...BASE_ENV, ...overrides } as NodeJS.ProcessEnv
  }

  function writeCatalog(contents: string): string {
    const filePath = join(temporaryDirectory, 'rooms.yaml')
    writeFileSync(filePath, contents)
    return filePath
  }

  it('keeps the legacy enrollment flow enabled when no catalog is configured', () => {
    setEnvironment({})

    expect(envToConfig(parseEnv()).roomCatalog).toBeUndefined()
  })

  it('loads selected-room enrollment without an operator redirect allow-list', () => {
    const roomCatalogFile = writeCatalog(`feeds:
  - id: bebop
    boundary: did:web:host/nebula
    displayName: Bebop
    description: Cowboy Bebop night shift.
`)
    setEnvironment({ STRATOS_ROOM_CATALOG_FILE: roomCatalogFile })

    expect(envToConfig(parseEnv()).roomCatalog?.get('bebop')).toEqual(
      expect.objectContaining({ available: true }),
    )
  })

  it('loads only room boundaries the service is allowed to enroll', () => {
    const roomCatalogFile = writeCatalog(`feeds:
  - id: bebop
    boundary: did:web:host/nebula
    displayName: Bebop
    description: Cowboy Bebop night shift.
`)
    setEnvironment({
      STRATOS_ROOM_CATALOG_FILE: roomCatalogFile,
    })

    expect(envToConfig(parseEnv()).roomCatalog?.get('bebop')).toEqual({
      id: 'bebop',
      boundary: 'did:web:host/nebula',
      displayName: 'Bebop',
      description: 'Cowboy Bebop night shift.',
      available: true,
    })
  })
})
