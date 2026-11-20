import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = resolve(HERE, 'fixtures')
const GENERATOR_FILE = 'generate-oracle-vectors.mjs'

const CLASSIFICATIONS = [
  'upstream-legacy-uri',
  'rfc',
  'upstream-uri-free',
  'target-uri-synthetic',
]
const HEX_64 = /^[0-9a-f]{64}$/
const LEGACY_SPACE_URI = /at:\/\/[^"\s]*\/space\//
const CRYPTO_FIELD_NAME = /mac|signature|digest|hash|secret|cid/i

// What a byte field named like this must decode to.
const EXPECTED_LENGTH_BY_NAME: Array<[RegExp, number]> = [
  [/secret/i, 32],
  [/digest/i, 32],
  [/state/i, 2048],
  [/^signature$/i, 64],
]

interface ByteField {
  encoding: string
  value: string
  length: number
}

interface FixtureFile {
  header: {
    classification: string
    oracle: Record<string, unknown>
    generator: string | { path: string; sha256: string }
    upstreamVerified: boolean
    reproducible: boolean
    reproducibleReason?: string
  }
  [key: string]: unknown
}

interface ManifestFixture {
  path: string
  sha256: string
  classification: string
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function loadManifestFixtures(): ManifestFixture[] {
  const manifest = JSON.parse(
    readFileSync(resolve(HERE, 'sources.json'), 'utf8'),
  ) as { fixtures: ManifestFixture[] }
  return manifest.fixtures
}

function fixturePaths(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name !== GENERATOR_FILE)
    .sort()
}

function loadFixture(name: string): FixtureFile {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), 'utf8'))
}

function isByteField(value: unknown): value is ByteField {
  return (
    typeof value === 'object' &&
    value !== null &&
    'encoding' in value &&
    'value' in value &&
    'length' in value
  )
}

function walk(
  value: unknown,
  path: string,
  visit: (path: string, key: string, value: unknown) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, visit))
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, child] of Object.entries(value)) {
    visit(path, key, child)
    walk(child, `${path}.${key}`, visit)
  }
}

function decodedLength(field: ByteField): number {
  if (field.encoding === 'hex') return Buffer.from(field.value, 'hex').length
  if (field.encoding === 'base64')
    return Buffer.from(field.value, 'base64').length
  return -1
}

function fieldKeys(value: unknown): string[] {
  const keys: string[] = []
  walk(value, '', (_path, key) => keys.push(key))
  return keys
}

describe('november fixture manifest', () => {
  const listed = loadManifestFixtures()

  it('lists every file under fixtures/ and nothing else', () => {
    expect(listed.map((entry) => entry.path).sort()).toEqual(fixturePaths())
  })

  it('records each file hash', () => {
    const wrong = listed
      .filter(
        (entry) => sha256Of(resolve(FIXTURES_DIR, entry.path)) !== entry.sha256,
      )
      .map((entry) => entry.path)
    expect(wrong).toEqual([])
  })

  it('records the classification the file declares', () => {
    const wrong = listed
      .filter(
        (entry) =>
          loadFixture(entry.path).header.classification !==
          entry.classification,
      )
      .map((entry) => entry.path)
    expect(wrong).toEqual([])
  })
})

describe('november fixture attribution', () => {
  const names = fixturePaths()
  const generatorHash = sha256Of(resolve(FIXTURES_DIR, GENERATOR_FILE))

  it('has a complete header with a known classification', () => {
    const problems: string[] = []
    for (const name of names) {
      const { header } = loadFixture(name)
      if (!header || !CLASSIFICATIONS.includes(header.classification))
        problems.push(`${name}: classification`)
      if (typeof header?.oracle !== 'object' || header.oracle === null)
        problems.push(`${name}: oracle`)
      if (header?.generator === undefined) problems.push(`${name}: generator`)
      if (typeof header?.upstreamVerified !== 'boolean')
        problems.push(`${name}: upstreamVerified`)
      if (typeof header?.reproducible !== 'boolean')
        problems.push(`${name}: reproducible`)
      if (header?.reproducible === false && !header.reproducibleReason)
        problems.push(`${name}: reproducibleReason`)
    }
    expect(problems).toEqual([])
  })

  it('names a package oracle or an rfc source', () => {
    const problems: string[] = []
    for (const name of names) {
      const { header } = loadFixture(name)
      const oracle = header.oracle
      const isPackage =
        typeof oracle['package'] === 'string' &&
        typeof oracle['version'] === 'string' &&
        typeof oracle['integrity'] === 'string'
      const isHandDerived = header.generator === 'hand-derived'
      const isRfc =
        typeof oracle['source'] === 'string' &&
        typeof oracle['url'] === 'string' &&
        typeof oracle['commit'] === 'string' &&
        HEX_64.test(String(oracle['sha256']))
      if (!isPackage && !isRfc && !isHandDerived)
        problems.push(`${name}: oracle is neither package nor rfc source`)
      if (isPackage && isRfc)
        problems.push(`${name}: oracle names both a package and an rfc source`)
    }
    expect(problems).toEqual([])
  })

  it('classifies a file as rfc exactly when its oracle is the rfc source', () => {
    const problems: string[] = []
    for (const name of names) {
      const { header } = loadFixture(name)
      const namesRfcSource = typeof header.oracle['commit'] === 'string'
      if ((header.classification === 'rfc') !== namesRfcSource)
        problems.push(`${name}: ${header.classification}`)
      if (header.classification === 'rfc' && header.upstreamVerified)
        problems.push(
          `${name}: an rfc file is not verified against the package`,
        )
    }
    expect(problems).toEqual([])
  })

  it('keeps package-derived values out of the rfc file', () => {
    const rfcFiles = names.filter(
      (name) => loadFixture(name).header.classification === 'rfc',
    )
    expect(rfcFiles.length).toBeGreaterThan(0)
    for (const name of rfcFiles)
      expect(Object.keys(loadFixture(name)).sort()).toEqual([
        'header',
        'rfcEntry',
      ])
  })

  it('pins the generator that produced each generated file', () => {
    const wrong = names.filter((name) => {
      const { generator } = loadFixture(name).header
      return (
        generator !== 'hand-derived' &&
        (typeof generator === 'string' || generator.sha256 !== generatorHash)
      )
    })
    expect(wrong).toEqual([])
  })

  it('classifies any file holding a legacy space uri as upstream-legacy-uri', () => {
    const wrong = names.filter(
      (name) =>
        LEGACY_SPACE_URI.test(
          readFileSync(resolve(FIXTURES_DIR, name), 'utf8'),
        ) && loadFixture(name).header.classification !== 'upstream-legacy-uri',
    )
    expect(wrong).toEqual([])
  })

  it('keeps synthetic target uri files free of legacy uris and upstream claims', () => {
    const problems: string[] = []
    for (const name of names) {
      const fixture = loadFixture(name)
      if (fixture.header.classification !== 'target-uri-synthetic') continue
      if (fixture.header.upstreamVerified !== false)
        problems.push(`${name}: upstreamVerified`)
      if (
        LEGACY_SPACE_URI.test(readFileSync(resolve(FIXTURES_DIR, name), 'utf8'))
      )
        problems.push(`${name}: legacy uri`)
    }
    expect(problems).toEqual([])
  })

  it('keeps synthetic target uri files free of crypto fields', () => {
    const problems: string[] = []
    for (const name of names) {
      const fixture = loadFixture(name)
      if (fixture.header.classification !== 'target-uri-synthetic') continue
      for (const key of fieldKeys(fixture)) {
        if (CRYPTO_FIELD_NAME.test(key)) problems.push(`${name}: ${key}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('has at least one fixture of each kind the baseline needs', () => {
    const present = new Set(
      names.map((name) => loadFixture(name).header.classification),
    )
    expect([...present].sort()).toEqual([...CLASSIFICATIONS].sort())
  })
})

describe('november fixture byte fields', () => {
  const names = fixturePaths()

  it('decodes every byte field to its declared length', () => {
    const wrong: string[] = []
    for (const name of names) {
      walk(loadFixture(name), name, (path, key, value) => {
        if (!isByteField(value)) return
        if (decodedLength(value) !== value.length)
          wrong.push(`${path}.${key}: ${value.length} declared`)
      })
    }
    expect(wrong).toEqual([])
  })

  it('gives secrets, digests, states and signatures their fixed sizes', () => {
    const wrong: string[] = []
    let checked = 0
    for (const name of names) {
      walk(loadFixture(name), name, (path, key, value) => {
        if (!isByteField(value)) return
        for (const [pattern, size] of EXPECTED_LENGTH_BY_NAME) {
          if (!pattern.test(key)) continue
          checked += 1
          if (value.length !== size)
            wrong.push(`${path}.${key}: ${value.length}, want ${size}`)
        }
      })
    }
    expect(wrong).toEqual([])
    expect(checked).toBeGreaterThan(0)
  })

  it('stays under the size budget', () => {
    const total = names.reduce(
      (sum, name) => sum + readFileSync(resolve(FIXTURES_DIR, name)).length,
      0,
    )
    expect(total).toBeLessThan(64 * 1024)
  })
})
