import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { envToConfig, parseEnv } from '../src/config.js'

const BASE_ENV: Record<string, string> = {
  STRATOS_SERVICE_DID: 'did:web:host',
  STRATOS_PUBLIC_URL: 'https://host.example.com',
  // `general` is the default reserved domain; it must appear in allowed domains.
  STRATOS_ALLOWED_DOMAINS: 'eng,ops,general',
}

describe('service enrollment config parsing', () => {
  let saved: NodeJS.ProcessEnv
  let tmp: string

  beforeEach(() => {
    saved = { ...process.env }
    tmp = mkdtempSync(join(tmpdir(), 'stratos-svc-enroll-'))
  })

  afterEach(() => {
    process.env = saved
    rmSync(tmp, { recursive: true, force: true })
  })

  /** Replace process.env with BASE_ENV plus overrides. */
  function setEnv(overrides: Record<string, string>): void {
    process.env = { ...BASE_ENV, ...overrides } as NodeJS.ProcessEnv
  }

  it('parses inline service enrollments and qualifies bare boundaries', () => {
    setEnv({
      STRATOS_SERVICE_ENROLLMENTS: JSON.stringify([
        { did: 'did:web:spiegel.appview', boundaries: ['eng'] },
      ]),
    })

    const config = envToConfig(parseEnv())

    expect(config.enrollment.serviceEnrollments).toEqual([
      { did: 'did:web:spiegel.appview', boundaries: ['did:web:host/eng'] },
    ])
  })

  it('parses service enrollments from a file', () => {
    const file = join(tmp, 'enrollments.json')
    writeFileSync(
      file,
      JSON.stringify([{ did: 'did:web:vash.appview', boundaries: ['ops'] }]),
    )
    setEnv({ STRATOS_SERVICE_ENROLLMENTS_FILE: file })

    const config = envToConfig(parseEnv())

    expect(config.enrollment.serviceEnrollments).toEqual([
      { did: 'did:web:vash.appview', boundaries: ['did:web:host/ops'] },
    ])
  })

  it('merges file and inline sources', () => {
    const file = join(tmp, 'enrollments.json')
    writeFileSync(
      file,
      JSON.stringify([{ did: 'did:web:vash.appview', boundaries: ['ops'] }]),
    )
    setEnv({
      STRATOS_SERVICE_ENROLLMENTS_FILE: file,
      STRATOS_SERVICE_ENROLLMENTS: JSON.stringify([
        { did: 'did:web:spiegel.appview', boundaries: ['eng'] },
      ]),
    })

    const config = envToConfig(parseEnv())

    expect(config.enrollment.serviceEnrollments).toHaveLength(2)
    const dids = config.enrollment.serviceEnrollments.map((e) => e.did)
    expect(dids).toContain('did:web:vash.appview')
    expect(dids).toContain('did:web:spiegel.appview')
  })

  it('rejects duplicate DIDs across file and inline sources', () => {
    const file = join(tmp, 'enrollments.json')
    writeFileSync(
      file,
      JSON.stringify([{ did: 'did:web:vash.appview', boundaries: ['ops'] }]),
    )
    setEnv({
      STRATOS_SERVICE_ENROLLMENTS_FILE: file,
      STRATOS_SERVICE_ENROLLMENTS: JSON.stringify([
        { did: 'did:web:vash.appview', boundaries: ['eng'] },
      ]),
    })

    expect(() => envToConfig(parseEnv())).toThrow(
      /duplicate service enrollment/,
    )
  })

  it('rejects boundaries outside allowedDomains', () => {
    setEnv({
      STRATOS_SERVICE_ENROLLMENTS: JSON.stringify([
        { did: 'did:web:legato.appview', boundaries: ['secret'] },
      ]),
    })

    expect(() => envToConfig(parseEnv())).toThrow(/not in allowedDomains/)
  })

  it('throws when the file cannot be read', () => {
    const missing = join(tmp, 'missing.json')
    setEnv({ STRATOS_SERVICE_ENROLLMENTS_FILE: missing })

    let caught: unknown
    try {
      envToConfig(parseEnv())
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain(
      'failed to read service enrollments file',
    )
    expect((caught as Error).message).toContain(missing)
    // The underlying filesystem error is preserved as the cause.
    expect((caught as Error).cause).toBeInstanceOf(Error)
  })

  it('rejects malformed JSON and names the inline source', () => {
    setEnv({ STRATOS_SERVICE_ENROLLMENTS: '{ not json' })

    let caught: unknown
    try {
      envToConfig(parseEnv())
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('STRATOS_SERVICE_ENROLLMENTS')
    expect((caught as Error).message).toContain('not valid JSON')
    // The underlying JSON parse error is preserved as the cause.
    expect((caught as Error).cause).toBeInstanceOf(Error)
  })

  it('rejects malformed JSON and names the file source', () => {
    const file = join(tmp, 'enrollments.json')
    writeFileSync(file, '{ not json')
    setEnv({ STRATOS_SERVICE_ENROLLMENTS_FILE: file })

    let caught: unknown
    try {
      envToConfig(parseEnv())
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain(`file "${file}"`)
    expect((caught as Error).message).toContain('not valid JSON')
  })

  it('rejects inline JSON that is not an array', () => {
    setEnv({ STRATOS_SERVICE_ENROLLMENTS: JSON.stringify({ did: 'x' }) })

    let caught: unknown
    try {
      envToConfig(parseEnv())
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('STRATOS_SERVICE_ENROLLMENTS')
    expect((caught as Error).message).toContain('must be a JSON array')
  })

  it('rejects file JSON that is not an array', () => {
    const file = join(tmp, 'enrollments.json')
    writeFileSync(file, JSON.stringify({ did: 'x' }))
    setEnv({ STRATOS_SERVICE_ENROLLMENTS_FILE: file })

    let caught: unknown
    try {
      envToConfig(parseEnv())
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain(`file "${file}"`)
    expect((caught as Error).message).toContain('must be a JSON array')
  })

  it('defaults to an empty list when unset', () => {
    setEnv({})

    const config = envToConfig(parseEnv())

    expect(config.enrollment.serviceEnrollments).toEqual([])
  })
})
