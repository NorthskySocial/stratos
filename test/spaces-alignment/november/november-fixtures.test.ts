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
  'target-uri-conformance',
  'upstream-signed-target-uri',
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
        ) &&
        !['upstream-legacy-uri', 'target-uri-conformance'].includes(
          loadFixture(name).header.classification,
        ),
    )
    expect(wrong).toEqual([])
  })

  it('lets a conformance file hold a legacy space uri only as a flagged invalid input', () => {
    const problems: string[] = []
    let checked = 0
    for (const name of names) {
      const fixture = loadFixture(name)
      if (fixture.header.classification !== 'target-uri-conformance') continue
      checked += 1
      if (fixture.header.upstreamVerified !== false)
        problems.push(`${name}: upstreamVerified`)
      const invalid = (fixture['invalid'] ?? []) as Array<{
        input: string
        legacy: boolean
      }>
      const rest = { ...fixture, invalid: [] }
      if (LEGACY_SPACE_URI.test(JSON.stringify(rest)))
        problems.push(`${name}: legacy uri outside invalid`)
      for (const entry of invalid) {
        if (LEGACY_SPACE_URI.test(entry.input) && entry.legacy !== true)
          problems.push(`${name}: unflagged legacy input ${entry.input}`)
      }
      for (const key of fieldKeys(fixture)) {
        if (CRYPTO_FIELD_NAME.test(key)) problems.push(`${name}: ${key}`)
      }
    }
    expect(problems).toEqual([])
    expect(checked).toBeGreaterThan(0)
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

describe('credential presentation vectors', () => {
  interface PresentationCase {
    name: string
    headers: Record<string, string>
    keyId: string
    verdict: { accepted: boolean; error?: string; message?: string }
  }
  const fixture = loadFixture('credential-signature.json') as FixtureFile & {
    accepted: { authorization: string; headers: Record<string, string> }
    cases: PresentationCase[]
  }
  const EXPECTED_VERDICTS: Array<[string, boolean]> = [
    ['accepted as signed', true],
    ['accepted under another label with the right tag', true],
    ['two signatures carry the tag', false],
    ['no signature carries the tag', false],
    ['components reordered', false],
    ['an extra component', false],
    ['verified against the wrong key', false],
    ['authorization value altered', false],
    ['scheme in mixed case, signed as written', true],
    ['a created parameter', true],
    ['keyid equal to the key', true],
    ['keyid of another key', false],
    ['alg ecdsa-p256-sha256', true],
    ['another alg', false],
    ['a second signature with another tag beside the right one', true],
  ]

  it('presents the credential under the Atproto-Space-Credential scheme', () => {
    expect(fixture.accepted.authorization).toMatch(
      /^Atproto-Space-Credential \S+$/,
    )
    expect(fixture.accepted.headers['authorization']).toBe(
      fixture.accepted.authorization,
    )
  })

  it('holds one oracle verdict for each case, with the expected outcome', () => {
    const actual = fixture.cases.map((entry) => [
      entry.name,
      entry.verdict.accepted,
    ])
    expect(actual).toEqual(EXPECTED_VERDICTS)
  })

  it('records an error name and message for every refusal', () => {
    for (const entry of fixture.cases) {
      if (entry.verdict.accepted) continue
      expect(entry.verdict.error, entry.name).toEqual(expect.any(String))
      expect(entry.verdict.message, entry.name).toEqual(expect.any(String))
    }
  })
})

describe('token audience vectors', () => {
  const AUTHORITY = 'did:web:bebop.example'
  const FILE = 'token-audiences.json'
  const VERDICT = /^(accepted|refused: \w+)$/
  const REQUIRED_TOKENS = [
    'delegation',
    'delegation with the retired audience',
    'client attestation',
    'credential',
    'credential without kid',
    'credential with another kid',
    'credential with an aud claim',
    'credential with alg none',
    'credential bound to a non-P-256 key',
    'credential without cnf',
    'credential signed by another key',
  ]

  interface TokenEntry {
    name: string
    token: string
    frozenClockSeconds: number
    verdicts: { parse: string; verify: string }
  }
  const fixture = loadFixture(FILE) as FixtureFile & {
    authority: string
    tokens: TokenEntry[]
  }
  const decodePart = (token: string, index: number): Record<string, unknown> =>
    JSON.parse(Buffer.from(token.split('.')[index], 'base64url').toString())
  const entry = (name: string): TokenEntry => {
    const found = fixture.tokens.find((candidate) => candidate.name === name)
    if (!found) throw new Error(`no token named ${name}`)
    return found
  }

  it('is signed by the oracle and stored once, with its reason', () => {
    expect(fixture.header.classification).toBe('upstream-signed-target-uri')
    expect(fixture.header.upstreamVerified).toBe(true)
    expect(fixture.header.reproducible).toBe(false)
    expect(fixture.header.reproducibleReason).toMatch(/clock/)
    expect(fixture.header.reproducibleReason).toMatch(/random/)
  })

  it('holds every required token, each with a clock and both verdicts', () => {
    expect(fixture.tokens.map((token) => token.name)).toEqual(REQUIRED_TOKENS)
    for (const token of fixture.tokens) {
      expect(token.token.split('.'), token.name).toHaveLength(3)
      expect(Number.isInteger(token.frozenClockSeconds), token.name).toBe(true)
      expect(token.verdicts.parse, token.name).toMatch(VERDICT)
      expect(token.verdicts.verify, token.name).toMatch(VERDICT)
    }
  })

  it('names the authority host service as the audience of delegations and attestations', () => {
    for (const name of ['delegation', 'client attestation']) {
      expect(decodePart(entry(name).token, 1)['aud'], name).toBe(
        `${AUTHORITY}#atproto_pds`,
      )
    }
    expect(decodePart(entry('delegation').token, 1)['sub']).toMatch(
      /^at:space\/did:web:bebop\.example\/[^/]+\/[^/]+$/,
    )
    expect(
      decodePart(entry('delegation with the retired audience').token, 1)['aud'],
    ).toBe(`${AUTHORITY}#atproto_space_host`)
  })

  it('records the oracle verdicts the services must agree with', () => {
    const outcome = (name: string) => {
      const { parse, verify } = entry(name).verdicts
      return [parse, verify]
    }
    const ACCEPTED = 'accepted'
    expect(outcome('delegation')).toEqual([ACCEPTED, ACCEPTED])
    expect(outcome('delegation with the retired audience')).toEqual([
      ACCEPTED,
      'refused: BadJwtAudience',
    ])
    expect(outcome('client attestation')).toEqual([ACCEPTED, ACCEPTED])
    expect(outcome('credential')).toEqual([ACCEPTED, ACCEPTED])
    expect(outcome('credential without kid')).toEqual([
      'refused: BadJwt',
      'refused: BadJwt',
    ])
    expect(outcome('credential with another kid')).toEqual([
      'refused: BadJwt',
      'refused: BadJwt',
    ])
    expect(outcome('credential with an aud claim')).toEqual([
      ACCEPTED,
      ACCEPTED,
    ])
    expect(outcome('credential bound to a non-P-256 key')).toEqual([
      ACCEPTED,
      ACCEPTED,
    ])
    expect(outcome('credential without cnf')).toEqual([
      'refused: BadJwtCnf',
      'refused: BadJwtCnf',
    ])
    expect(outcome('credential signed by another key')).toEqual([
      ACCEPTED,
      'refused: BadJwtSignature',
    ])
    expect(outcome('credential with alg none')).toEqual([
      ACCEPTED,
      'refused: BadJwtSignature',
    ])
  })

  it('gives the verify step a clock that covers each token', () => {
    for (const token of fixture.tokens) {
      const payload = decodePart(token.token, 1)
      expect(token.frozenClockSeconds, token.name).toBeGreaterThanOrEqual(
        payload['iat'] as number,
      )
      expect(token.frozenClockSeconds, token.name).toBeLessThan(
        payload['exp'] as number,
      )
    }
  })
})

describe('values Stratos produced, judged by the upstream package', () => {
  const FILE = 'stratos-produced.json'
  const REPO_ROOT = resolve(HERE, '../../..')
  const ACCEPTED = 'accepted'

  interface Verdicts {
    parse: string
    verify: string
  }
  const fixture = loadFixture(FILE) as FixtureFile & {
    rustPresentation: {
      source: string
      signingKeyFill: number
      keyId: string
      headers: Record<string, string>
      verdict: string
    }
    rustDelegation: {
      source: string
      signingKeyHex: string
      authority: string
      spaceUri: string
      token: string
      frozenClockSeconds: number
      verdicts: Verdicts
    }
    serviceCredential: {
      source: string
      authority: string
      spaceUri: string
      authoritySigningKeyHex: string
      holderKeyHex: string
      credentialId: string
      token: string
      frozenClockSeconds: number
      verdicts: Verdicts
    }
  }
  const { rustPresentation, rustDelegation, serviceCredential } = fixture

  const sourceText = (path: string): string =>
    readFileSync(resolve(REPO_ROOT, path), 'utf8')
  // The value of `const NAME: &str = "...";` in Rust, or `const NAME = '...'`
  // in TypeScript, as the compiler reads the literal.
  const constantIn = (path: string, name: string): string => {
    const text = sourceText(path)
    const rust = new RegExp(
      `const ${name}: &str =\\s*"((?:[^"\\\\]|\\\\.)*)";`,
    ).exec(text)
    if (rust) return rust[1].replace(/\\(.)/g, '$1')
    const typescript = new RegExp(`const ${name} =\\s*'([^']*)'`).exec(text)
    if (typescript) return typescript[1]
    throw new Error(`no constant ${name} in ${path}`)
  }
  const claimsOf = (token: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

  it('is judged by the oracle and reproducible', () => {
    expect(fixture.header.classification).toBe('upstream-signed-target-uri')
    expect(fixture.header.upstreamVerified).toBe(true)
    expect(fixture.header.reproducible).toBe(true)
  })

  it('has every verdict accepted', () => {
    expect(rustPresentation.verdict).toBe(ACCEPTED)
    expect(rustDelegation.verdicts).toEqual({
      parse: ACCEPTED,
      verify: ACCEPTED,
    })
    expect(serviceCredential.verdicts).toEqual({
      parse: ACCEPTED,
      verify: ACCEPTED,
    })
  })

  it('judges the Rust presentation exactly as the Rust test pins it', () => {
    const { source, headers, signingKeyFill } = rustPresentation
    expect(headers['authorization']).toBe(
      constantIn(source, 'FIXED_PRESENTATION_AUTHORIZATION'),
    )
    expect(headers['atproto-space-audience']).toBe(
      constantIn(source, 'FIXED_AUDIENCE'),
    )
    expect(headers['signature-input']).toBe(
      constantIn(source, 'FIXED_PRESENTATION_SIGNATURE_INPUT'),
    )
    expect(headers['signature']).toBe(
      constantIn(source, 'FIXED_PRESENTATION_SIGNATURE'),
    )
    expect(sourceText(source)).toContain(
      `SigningKey::from_slice(&[${signingKeyFill}; 32])`,
    )
    expect(Object.keys(headers).sort()).toEqual([
      'atproto-space-audience',
      'authorization',
      'signature',
      'signature-input',
    ])
  })

  it('judges the Rust delegation exactly as the Rust test pins it', () => {
    const { source, token, signingKeyHex, authority, spaceUri } = rustDelegation
    expect(token).toBe(constantIn(source, 'FIXED_DELEGATION_TOKEN'))
    expect(signingKeyHex).toBe(constantIn(source, 'TEST_ONLY_SIGNING_KEY'))
    expect(authority).toBe(constantIn(source, 'PORT_AUTHORITY_DID'))
    expect(spaceUri).toBe(constantIn(source, 'PORT_AUTHORITY_SPACE'))
    const claims = claimsOf(token)
    expect(claims['sub']).toBe(spaceUri)
    expect(claims['aud']).toBe(`${authority}#atproto_pds`)
    expect(claims['iat']).toBe(rustDelegation.frozenClockSeconds)
  })

  it('judges the service credential exactly as the service test pins it', () => {
    const { source, token, credentialId } = serviceCredential
    expect(token).toBe(constantIn(source, 'FIXED_CREDENTIAL'))
    expect(serviceCredential.authoritySigningKeyHex).toBe(
      constantIn(source, 'AUTHORITY_SIGNING_KEY_HEX'),
    )
    expect(serviceCredential.holderKeyHex).toBe(
      constantIn(source, 'HOLDER_KEY_HEX'),
    )
    expect(credentialId).toBe(constantIn(source, 'CREDENTIAL_ID'))
    expect(serviceCredential.authority).toBe(
      constantIn(source, 'AUTHORITY_DID'),
    )
    const claims = claimsOf(token)
    expect(claims['jti']).toBe(credentialId)
    expect(claims['sub']).toBe(serviceCredential.spaceUri)
    expect(claims['iat']).toBe(serviceCredential.frozenClockSeconds)
    expect(sourceText(source)).toContain(
      `const FROZEN_CLOCK_SECONDS = ${String(serviceCredential.frozenClockSeconds).replace(/\B(?=(\d{3})+$)/g, '_')}`,
    )
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
    expect(total).toBeLessThan(128 * 1024)
  })
})
