import { createHash, createHmac } from 'node:crypto'
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
      constantIn(source, 'UPSTREAM_PRESENTATION_SIGNATURE'),
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

  describe('the Rust MAC request', () => {
    const { rustMacRequest } = fixture as unknown as {
      rustMacRequest: {
        source: string
        acceptSignature: string
        sharedSecret: ByteField
        commit: { space: string; data: ByteField }
        oracle: {
          parseRequest: string
          keyShare: string
          decapsulate: string
          createCommitMacHeaders: string
        }
        responseHeaders: Record<string, string>
      }
    }

    it('has the oracle accept the request, derive the same secret and answer it', () => {
      expect(rustMacRequest.oracle).toEqual({
        parseRequest: ACCEPTED,
        keyShare: expect.stringMatching(/^did:key:z/),
        decapsulate: 'same-secret',
        createCommitMacHeaders: 'made',
      })
      expect(rustMacRequest.acceptSignature).toContain(
        `keyid="${rustMacRequest.oracle.keyShare}"`,
      )
      expect(Object.keys(rustMacRequest.responseHeaders).sort()).toEqual([
        'atproto-space-commit',
        'signature',
        'signature-input',
      ])
      expect(rustMacRequest.responseHeaders['atproto-space-commit']).toContain(
        `space="${rustMacRequest.commit.space}"`,
      )
      expect(rustMacRequest.commit.space).toMatch(/^at:space\/did:web:/)
    })

    it('judges the constants the Rust test pins', () => {
      expect(rustMacRequest.acceptSignature).toBe(
        constantIn(rustMacRequest.source, 'FIXED_ACCEPT_SIGNATURE'),
      )
      expect(rustMacRequest.sharedSecret.value).toBe(
        constantIn(rustMacRequest.source, 'FIXED_SHARED_SECRET_BASE64'),
      )
    })
  })

  describe('the Rust record CIDs and set hash', () => {
    const { rustRecordCids, rustSetHash } = fixture as unknown as {
      rustRecordCids: {
        source: string
        records: {
          name: string
          constant: string
          json: string
          rustCid: string
          oracleCid: string
        }[]
      }
      rustSetHash: {
        source: string
        steps: unknown[][]
        rustStateBase64: string
        rustDigestHex: string
        oracleStateBase64: string
        oracleDigestHex: string
      }
    }
    // The value of `const NAME: &str = r#"..."#;`, a Rust raw string.
    const rawConstantIn = (path: string, name: string): string => {
      const match = new RegExp(
        `const ${name}: &str =\\s*r#"(.*?)"#;`,
        's',
      ).exec(sourceText(path))
      if (!match) throw new Error(`no raw constant ${name} in ${path}`)
      return match[1]
    }

    it('names the upstream lex-json package in the header', () => {
      expect(fixture.header.oracle['additionalPackages']).toEqual([
        expect.objectContaining({ package: '@atproto/lex-json' }),
      ])
    })

    it('has the oracle compute the CID Stratos pinned for each fixed record', () => {
      expect(rustRecordCids.records).toHaveLength(3)
      for (const record of rustRecordCids.records)
        expect(record.oracleCid, record.name).toBe(record.rustCid)
    })

    it('judges the record texts and CIDs exactly as the Rust test pins them', () => {
      const { source, records } = rustRecordCids
      for (const record of records) {
        expect(record.json, record.name).toBe(
          rawConstantIn(source, `${record.constant}_JSON`),
        )
        expect(record.rustCid, record.name).toBe(
          constantIn(source, `${record.constant}_CID`),
        )
      }
      expect(records.some((r) => r.json.includes('"$link"'))).toBe(true)
      expect(records.some((r) => r.json.includes('"$bytes"'))).toBe(true)
    })

    it('has the oracle reach the state and digest Stratos pinned after the fixed operations', () => {
      expect(rustSetHash.oracleStateBase64).toBe(rustSetHash.rustStateBase64)
      expect(rustSetHash.oracleDigestHex).toBe(rustSetHash.rustDigestHex)
      expect(Buffer.from(rustSetHash.rustStateBase64, 'base64')).toHaveLength(
        2048,
      )
      expect(rustSetHash.rustDigestHex).toMatch(/^[0-9a-f]{64}$/)
    })

    it('judges the state and digest exactly as the Rust test pins them', () => {
      const { source, rustStateBase64, rustDigestHex } = rustSetHash
      expect(rustStateBase64).toBe(
        constantIn(source, 'CROSS_CHECK_STATE_BASE64'),
      )
      expect(rustDigestHex).toBe(constantIn(source, 'CROSS_CHECK_DIGEST_HEX'))
    })
  })
})

describe('commit mac vectors', () => {
  const FILE = 'commit-mac.json'
  const COVERED = 'atproto-space-commit'
  const ACCEPTED = 'accepted'
  const REFUSED = /^refused: \S/

  interface MacCase {
    name: string
    edit?: Record<string, [string, string]>
    set?: Record<string, string>
    remove?: string[]
    bodyChange?: Record<string, unknown>
    verdict: string
  }
  interface StricterCase extends Omit<MacCase, 'verdict'> {
    oracleVerdict: string
    expectedStratos: string
    reason: string
  }
  const fixture = loadFixture(FILE) as FixtureFile & {
    acceptSignature: string
    sharedSecret: ByteField
    commit: {
      ver: number
      repo: string
      space: string
      rev: string
      data: ByteField
    }
    headers: Record<string, string>
    cases: MacCase[]
    stricter: StricterCase[]
  }
  const exportFixture = loadFixture(
    'hpke-export-oracle.json',
  ) as FixtureFile & {
    oracleExport: { keyShareDid: string; sharedSecret: ByteField }
  }

  const EXPECTED_VERDICTS: Array<[string, boolean]> = [
    ['accepted as made', true],
    ['under another label', true],
    ['a second signature of another tag', true],
    ['alg hmac-sha256 in the request', true],
    ['extra spaces between members', true],
    ['members re-ordered with the old mac', false],
    ['members re-ordered, mac over that order', true],
    ['an extra member, mac over it', true],
    ['a member parameter, mac over it', true],
    ['ver changed in the header only', false],
    ['repo changed in the header only', false],
    ['space changed in the header only', false],
    ['rev changed in the header only', false],
    ['data changed in the header only', false],
    ['ver changed in the body only', false],
    ['repo changed in the body only', false],
    ['space changed in the body only', false],
    ['rev changed in the body only', false],
    ['data changed in the body only', false],
    ['two tagged members', false],
    ['no tagged member', false],
    ['tag atproto-space-repo', false],
    ['covered component without sf', false],
    ['an extra covered component', false],
    ['keyid of another key share', false],
    ['another alg', false],
    ['signature of 31 bytes', false],
    ['covered header missing', false],
    ['only an Atproto-Space-Mac header', false],
  ]
  const EXPECTED_STRICTER = [
    'ver 2 in header and body',
    'rev that is not a TID',
    'data of 31 bytes',
    'ver as the string "1"',
  ]

  it('is made and judged by the oracle and reproducible', () => {
    expect(fixture.header.classification).toBe('upstream-signed-target-uri')
    expect(fixture.header.upstreamVerified).toBe(true)
    expect(fixture.header.reproducible).toBe(true)
  })

  it('uses the key share and secret the export fixture pins', () => {
    const { keyShareDid, sharedSecret } = exportFixture.oracleExport
    expect(fixture.sharedSecret).toEqual(sharedSecret)
    expect(fixture.acceptSignature).toBe(
      `mac=("atproto-space-commit";sf);keyid="${keyShareDid}";tag="atproto-space-commit"`,
    )
    expect(fixture.headers['signature-input']).toBe(fixture.acceptSignature)
  })

  it('carries an opaque new-form space uri and a 32 byte data digest', () => {
    expect(fixture.commit.space).toMatch(/^at:space\/did:[^/]+\/[^/]+\/[^/]+$/)
    expect(fixture.commit.ver).toBe(1)
    expect(fixture.commit.data.length).toBe(32)
  })

  it('holds a mac that is the HMAC-SHA256 of the signature base under the secret', () => {
    const { headers } = fixture
    const params = /^mac=(.*)$/.exec(headers['signature-input'])?.[1]
    const base = [
      `"${COVERED}";sf: ${headers[COVERED]}`,
      `"@signature-params": ${params}`,
    ].join('\n')
    const mac = createHmac(
      'sha256',
      Buffer.from(fixture.sharedSecret.value, 'base64'),
    )
      .update(base)
      .digest('base64')
    expect(headers['signature']).toBe(`mac=:${mac}:`)
  })

  it('holds one oracle verdict for each case, with the expected outcome', () => {
    expect(
      fixture.cases.map((entry) => [entry.name, entry.verdict === ACCEPTED]),
    ).toEqual(EXPECTED_VERDICTS)
  })

  it('gives the oracle message for every refusal', () => {
    for (const entry of fixture.cases) {
      expect(
        entry.verdict === ACCEPTED || REFUSED.test(entry.verdict),
        entry.name,
      ).toBe(true)
    }
  })

  it('changes only headers the accepted response has, or the old mac header', () => {
    const known = new Set([
      ...Object.keys(fixture.headers),
      'acceptSignature',
      'atproto-space-mac',
    ])
    for (const entry of fixture.cases) {
      const named = [
        ...Object.keys(entry.edit ?? {}),
        ...Object.keys(entry.set ?? {}),
        ...(entry.remove ?? []),
      ]
      for (const name of named) expect(known.has(name), entry.name).toBe(true)
    }
  })

  it('edits only text the accepted headers hold', () => {
    const subject: Record<string, string> = {
      ...fixture.headers,
      acceptSignature: fixture.acceptSignature,
    }
    for (const entry of [...fixture.cases, ...fixture.stricter]) {
      for (const [name, [from]] of Object.entries(entry.edit ?? {}))
        expect(subject[name], `${entry.name}: ${name}`).toContain(from)
    }
  })

  it('names the stricter cases, which the oracle accepts and Stratos refuses', () => {
    expect(fixture.stricter.map((entry) => entry.name)).toEqual(
      EXPECTED_STRICTER,
    )
    for (const entry of fixture.stricter) {
      expect(entry.oracleVerdict, entry.name).toBe(ACCEPTED)
      expect(entry.expectedStratos, entry.name).toBe('refused')
      expect(entry.reason, entry.name).toEqual(expect.any(String))
    }
  })
})

describe('kem key vectors', () => {
  const FILE = 'kem-keys.json'
  const SYNTHETIC_DID = 'did:plc:spike'
  const OTHER_DID = 'did:plc:vicioussyndicate'

  interface KemMethod {
    id: string
    type: string
    publicKeyMultibase: string
  }
  interface KemCase {
    name: string
    document: { id: string; verificationMethod: KemMethod[] }
    expected: { kemKey?: string; refused?: string }
    oracleKeyVerdict?: string
  }
  const fixture = loadFixture(FILE) as FixtureFile & {
    did: string
    cases: KemCase[]
  }
  const exportFixture = loadFixture(
    'hpke-export-oracle.json',
  ) as FixtureFile & { oracleExport: { authorKemDid: string } }
  const EXPECTED_OUTCOMES: Array<[string, 'found' | 'refused']> = [
    ['a Multikey method with a relative id', 'found'],
    ['the same with an absolute id', 'found'],
    ['the legacy type with bare key bytes', 'found'],
    ['a KEM key different from the signing key', 'found'],
    ['no KEM method', 'refused'],
    ['a KEM method holding a secp256k1 key', 'refused'],
    ['a Multikey with a malformed multibase string', 'refused'],
    ['a document whose id is another DID', 'refused'],
    ['two methods with the KEM id', 'refused'],
  ]
  const byName = (name: string): KemCase => {
    const found = fixture.cases.find((candidate) => candidate.name === name)
    if (!found) throw new Error(`no case named ${name}`)
    return found
  }

  it('is uri free and judged by the oracle', () => {
    expect(fixture.header.classification).toBe('upstream-uri-free')
    expect(fixture.header.upstreamVerified).toBe(true)
    expect(fixture.header.reproducible).toBe(true)
  })

  it('holds one outcome for each document', () => {
    expect(
      fixture.cases.map((entry) => [
        entry.name,
        entry.expected.kemKey ? 'found' : 'refused',
      ]),
    ).toEqual(EXPECTED_OUTCOMES)
    for (const entry of fixture.cases)
      expect(Object.keys(entry.expected), entry.name).toHaveLength(1)
  })

  it('writes the one key three ways, and keeps the signing key apart', () => {
    const relative = byName('a Multikey method with a relative id')
    const absolute = byName('the same with an absolute id')
    const legacy = byName('the legacy type with bare key bytes')
    const different = byName('a KEM key different from the signing key')
    const [relativeMethod] = relative.document.verificationMethod
    const [legacyMethod] = legacy.document.verificationMethod
    expect(relativeMethod.id).toBe('#atproto_kem')
    expect(absolute.document.verificationMethod[0].id).toBe(
      `${SYNTHETIC_DID}#atproto_kem`,
    )
    expect(legacyMethod.type).toBe('EcdsaSecp256r1VerificationKey2019')
    expect(relativeMethod.publicKeyMultibase).toMatch(/^zDn/)
    expect(legacyMethod.publicKeyMultibase).not.toMatch(/^zDn/)
    expect(relative.expected.kemKey).toBe(
      exportFixture.oracleExport.authorKemDid,
    )
    expect(absolute.expected.kemKey).toBe(relative.expected.kemKey)
    expect(legacy.expected.kemKey).toBe(relative.expected.kemKey)
    const [signing, kem] = different.document.verificationMethod
    expect([signing.id, kem.id]).toEqual(['#atproto', '#atproto_kem'])
    expect(`did:key:${signing.publicKeyMultibase}`).not.toBe(
      different.expected.kemKey,
    )
    expect(different.expected.kemKey).toBe(relative.expected.kemKey)
  })

  it('has the oracle refuse the keys it can not use as a P-256 KEM key', () => {
    expect(
      byName('a Multikey method with a relative id').oracleKeyVerdict,
    ).toBe('accepted')
    for (const name of [
      'a KEM method holding a secp256k1 key',
      'a Multikey with a malformed multibase string',
    ])
      expect(byName(name).oracleKeyVerdict, name).toMatch(/^refused: \S/)
  })

  it('names the DID each document describes, except the one that names another', () => {
    for (const entry of fixture.cases) {
      const expectedId =
        entry.name === 'a document whose id is another DID'
          ? OTHER_DID
          : SYNTHETIC_DID
      expect(entry.document.id, entry.name).toBe(expectedId)
    }
    expect(fixture.did).toBe(SYNTHETIC_DID)
  })

  it('gives two methods the same KEM id in the ambiguous document', () => {
    const { verificationMethod } = byName(
      'two methods with the KEM id',
    ).document
    expect(verificationMethod).toHaveLength(2)
    expect(verificationMethod.every((m) => m.id.endsWith('#atproto_kem'))).toBe(
      true,
    )
  })
})

describe('record byte and cid vectors', () => {
  const FILE = 'record-cid.json'
  const HEX = /^[0-9a-f]+$/
  const ACCEPTED_OUTCOME = /^accepted ([0-9a-f]*) (bafyrei[a-z2-7]+)$/
  const REFUSED_OUTCOME = /^refused: \w+: \S/
  const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

  interface RecordVector {
    name: string
    json: string
    oracle: string
  }
  interface EdgeVector {
    name: string
    json: string
    oracle: string
    oracleStrict?: string
  }
  interface StricterVector extends EdgeVector {
    expectedStratos: string
    reason: string
  }
  interface CidString {
    name: string
    text: string
    parsesAsCborCid: boolean
    canonicalText: boolean
  }
  const fixture = loadFixture(FILE) as FixtureFile & {
    records: RecordVector[]
    edge: EdgeVector[]
    reasons: Record<string, string>
    stricter: StricterVector[]
    cidStrings: CidString[]
  }

  const EXPECTED_RECORDS = [
    'a post',
    'a post, edited',
    'a post, edited again',
    'a post by Ein',
    'a like with a strong reference',
    'a repost',
    'a follow',
    'a post with a blob reference',
    'a record with bytes',
    'nested maps and arrays',
    'keys that sort by length then bytes',
    'non-ASCII keys and values',
    'integers across every width',
    'empty containers, null and booleans',
  ]
  const EXPECTED_EDGE: Array<[string, boolean]> = [
    ['a number with a fraction', false],
    ['the integer 2^53', false],
    ['an exponent beyond the double range', false],
    ['a $link beside another key', true],
    ['a $link holding a number', true],
    ['a $link in base58 version 0', true],
    ['a $bytes unpadded', true],
    ['a $bytes padded', true],
    ['a $bytes beside another key', true],
    ['a key written twice', true],
    ['a string of 256 bytes', true],
    ['a combining character beside its precomposed form', true],
    ['a top level array', true],
    ['nesting 32 deep', true],
  ]
  const EXPECTED_STRICTER = [
    'the number 1.0',
    'the number 1e2',
    'the number -0',
    'nesting 33 deep',
    'a $link that is not a CID',
    'a $link in uppercase',
    'a $link in base58 version 1',
    'a $bytes that is not base64',
    'a $bytes in the URL-safe alphabet',
    'a $bytes with trailing bits',
    'a lone surrogate escape',
  ]
  const EXPECTED_CID_STRINGS: Array<[string, boolean, boolean]> = [
    ['the canonical text', true, true],
    ['the same cid in base58 version 1', true, false],
    ['the same cid in uppercase', false, false],
    ['a version 0 cid', false, true],
    ['a raw-codec cid', false, true],
  ]

  const base32 = (bytes: Buffer): string => {
    let bits = 0
    let acc = 0
    let out = ''
    for (const byte of bytes) {
      acc = (acc << 8) | byte
      bits += 8
      while (bits >= 5) {
        out += BASE32[(acc >> (bits - 5)) & 31]
        bits -= 5
      }
      acc &= (1 << bits) - 1
    }
    return bits > 0 ? out + BASE32[(acc << (5 - bits)) & 31] : out
  }
  const cidOfDagCbor = (bytesHex: string): string =>
    `b${base32(
      Buffer.concat([
        Buffer.from([0x01, 0x71, 0x12, 0x20]),
        createHash('sha256').update(Buffer.from(bytesHex, 'hex')).digest(),
      ]),
    )}`
  const outcomesOf = (row: EdgeVector): string[] =>
    row.oracleStrict ? [row.oracle, row.oracleStrict] : [row.oracle]

  it('is uri free, judged by the oracle and names the package that read the json', () => {
    expect(fixture.header.classification).toBe('upstream-uri-free')
    expect(fixture.header.upstreamVerified).toBe(true)
    expect(fixture.header.reproducible).toBe(true)
    expect(fixture.header.oracle['additionalPackages']).toEqual([
      expect.objectContaining({
        package: '@atproto/lex-json',
        version: fixture.header.oracle['version'],
        integrity: expect.stringMatching(/^sha512-/),
      }),
    ])
  })

  it('holds one vector for each record, in order', () => {
    expect(fixture.records.map((entry) => entry.name)).toEqual(EXPECTED_RECORDS)
  })

  it('gives each record the sha-256 dag-cbor cid of its bytes', () => {
    for (const entry of fixture.records) {
      const [, bytesHex, cid] = ACCEPTED_OUTCOME.exec(entry.oracle) ?? []
      expect(bytesHex, entry.name).toMatch(HEX)
      expect(cidOfDagCbor(bytesHex as string), entry.name).toBe(cid)
    }
  })

  it('writes every record as json that parses to a map', () => {
    for (const entry of fixture.records)
      expect(JSON.parse(entry.json), entry.name).toEqual(expect.any(Object))
  })

  it('holds one oracle verdict for each edge input, with the expected outcome', () => {
    expect(
      fixture.edge.map((entry) => [
        entry.name,
        ACCEPTED_OUTCOME.test(entry.oracle),
      ]),
    ).toEqual(EXPECTED_EDGE)
  })

  it('gives the bytes and cid for an accepted input and the message for a refused one', () => {
    for (const row of [...fixture.edge, ...fixture.stricter]) {
      for (const outcome of outcomesOf(row)) {
        const [, bytesHex, cid] = ACCEPTED_OUTCOME.exec(outcome) ?? []
        if (cid) expect(cidOfDagCbor(bytesHex as string), row.name).toBe(cid)
        else expect(outcome, row.name).toMatch(REFUSED_OUTCOME)
      }
    }
  })

  it('names the stricter cases, which the oracle accepts and Stratos refuses', () => {
    expect(fixture.stricter.map((entry) => entry.name)).toEqual(
      EXPECTED_STRICTER,
    )
    for (const entry of fixture.stricter) {
      expect(entry.oracle, entry.name).toMatch(ACCEPTED_OUTCOME)
      expect(entry.expectedStratos, entry.name).toBe('refused')
      expect(fixture.reasons[entry.reason], entry.name).toEqual(
        expect.any(String),
      )
    }
  })

  it('names each edge and stricter input once', () => {
    const names = [...fixture.edge, ...fixture.stricter].map(
      (entry) => entry.name,
    )
    expect(new Set(names).size).toBe(names.length)
  })

  it('classifies each received cid string by the oracle parse and its canonical form', () => {
    expect(
      fixture.cidStrings.map((entry) => [
        entry.name,
        entry.parsesAsCborCid,
        entry.canonicalText,
      ]),
    ).toEqual(EXPECTED_CID_STRINGS)
    expect(fixture.cidStrings[0]?.text).toBe(
      ACCEPTED_OUTCOME.exec(fixture.records[0]?.oracle ?? '')?.[2],
    )
  })
})

describe('op page vectors', () => {
  const FILE = 'op-pages.json'
  const SPACE = 'at:space/did:web:bebop.example/zone.stratos.space.feed/crew'
  const REPO = 'did:plc:fayevalentine'

  interface PageOp {
    rev: string
    collection: string
    rkey: string
    cid: string | null
    prev: string | null
    value?: unknown
  }
  interface Page {
    ops: PageOp[]
    commit: {
      ver: number
      repo: string
      space: string
      rev: string
      data: { $bytes: string }
    }
  }
  const fixture = loadFixture(FILE) as FixtureFile & {
    pages: Page[]
    stateAfterLastPage: ByteField
  }
  const recordFixture = loadFixture('record-cid.json') as FixtureFile & {
    records: Array<{ json: string; oracle: string }>
  }
  const allOps = (): PageOp[] => fixture.pages.flatMap((page) => page.ops)
  const kinds = (): string[] =>
    allOps().map((op) =>
      op.cid === null ? 'delete' : op.prev === null ? 'create' : 'update',
    )
  const digestOf = (page: Page): string =>
    Buffer.from(page.commit.data.$bytes, 'base64').toString('hex')

  it('is made by the oracle over a new-form space uri and reproducible', () => {
    expect(fixture.header.classification).toBe('upstream-signed-target-uri')
    expect(fixture.header.upstreamVerified).toBe(true)
    expect(fixture.header.reproducible).toBe(true)
    expect(fixture.header.oracle['additionalPackages']).toEqual([
      expect.objectContaining({ package: '@atproto/lex-json' }),
    ])
  })

  it('holds three pages for one repo in one space, the last without ops', () => {
    expect(fixture.pages).toHaveLength(3)
    for (const page of fixture.pages) {
      expect(page.commit.ver).toBe(1)
      expect(page.commit.repo).toBe(REPO)
      expect(page.commit.space).toBe(SPACE)
    }
    expect(fixture.pages[2]?.ops).toEqual([])
  })

  it('has a create, an update and a delete, and two ops on one path in one page', () => {
    expect(new Set(kinds())).toEqual(new Set(['create', 'update', 'delete']))
    const twice = fixture.pages.some((page) => {
      const paths = page.ops.map((op) => `${op.collection}/${op.rkey}`)
      return new Set(paths).size < paths.length
    })
    expect(twice).toBe(true)
  })

  it('has a like, a repost and a record of a collection the feed does not admit', () => {
    expect(new Set(allOps().map((op) => op.collection))).toEqual(
      new Set([
        'zone.stratos.feed.post',
        'app.bsky.feed.like',
        'app.bsky.feed.repost',
        'app.bsky.graph.follow',
      ]),
    )
  })

  it('takes every value and cid from the record vectors', () => {
    const jsonByCid = new Map(
      recordFixture.records.map((entry) => [
        / (bafyrei[a-z2-7]+)$/.exec(entry.oracle)?.[1],
        entry.json,
      ]),
    )
    for (const op of allOps()) {
      if (op.cid === null) {
        expect(op.value).toBeUndefined()
        continue
      }
      const json = jsonByCid.get(op.cid)
      expect(json, `${op.collection}/${op.rkey}`).toBeDefined()
      expect(op.value).toEqual(JSON.parse(json as string))
    }
  })

  it('gives each op the cid the path held before it as prev', () => {
    const live = new Map<string, string>()
    for (const op of allOps()) {
      const path = `${op.collection}/${op.rkey}`
      expect(live.get(path) ?? null, path).toBe(op.prev)
      if (op.cid === null) live.delete(path)
      else live.set(path, op.cid)
    }
  })

  it('moves the commit revision to the last op of each page and keeps it on an empty page', () => {
    let previous = ''
    for (const page of fixture.pages) {
      const last = page.ops.at(-1)
      expect(page.commit.rev).toBe(last ? last.rev : previous)
      expect(page.commit.rev >= previous).toBe(true)
      previous = page.commit.rev
    }
  })

  it('ends on a 2048 byte state whose sha-256 is the last commit digest', () => {
    const state = Buffer.from(fixture.stateAfterLastPage.value, 'base64')
    expect(state.length).toBe(2048)
    expect(createHash('sha256').update(state).digest('hex')).toBe(
      digestOf(fixture.pages[2] as Page),
    )
  })

  it('changes the digest on a page with ops and keeps it on an empty page', () => {
    const [first, second, empty] = fixture.pages as [Page, Page, Page]
    expect(digestOf(first)).not.toBe(digestOf(second))
    expect(digestOf(empty)).toBe(digestOf(second))
  })
})

describe('repo archive vectors', () => {
  const FILE = 'repo-archive.json'
  const SPACE = 'at:space/did:web:bebop.example/zone.stratos.space.feed/crew'
  const REPO = 'did:plc:fayevalentine'
  const COVERED = 'atproto-space-commit'
  const MAGIC = '2a6c0100'
  const MAX_FAMILY_BYTES = 6 * 1024
  const RECORDS: Array<[name: string, path: string]> = [
    ['a like with a strong reference', 'app.bsky.feed.like/ed'],
    ['a repost', 'app.bsky.feed.repost/jet'],
    ['a follow', 'app.bsky.graph.follow/faye'],
    ['a post', 'zone.stratos.feed.post/swordfish'],
  ]
  const REQUIRED_REFUSALS = [
    'cut before the end marker',
    'cut inside a value',
    'an unknown control byte',
    'one byte after the end',
    'two records swapped',
    'a record repeated',
    'a path that is not collection/rkey',
    'one value byte changed',
    'a non-canonical encoding of the record',
    'metadata type changed',
    'metadata revision changed',
    'a metadata length above the limit',
    'a key length above the limit',
    'a value length above the limit, no bytes',
  ]
  const ACCEPTED = 'accepted'

  interface Edit {
    name: string
    at: number
    remove: number
    insert: string
    verdict: string
  }
  const fixture = loadFixture(FILE) as FixtureFile & {
    archive: {
      bytes: string
      macHeaders: Record<string, string>
      verdict: string
      readerOnNewSpelling: string
    }
    empty: { bytes: string; verdict: string }
    refused: Edit[]
  }
  const macFixture = loadFixture('commit-mac.json') as FixtureFile & {
    acceptSignature: string
    sharedSecret: ByteField
  }
  const recordFixture = loadFixture('record-cid.json') as FixtureFile & {
    records: Array<{ name: string; oracle: string }>
  }
  const lthash = loadFixture('lthash.json') as FixtureFile & {
    emptyDigest: ByteField
  }
  const archiveBytes = (): Buffer =>
    Buffer.from(fixture.archive.bytes, 'base64')
  const emptyBytes = (): Buffer => Buffer.from(fixture.empty.bytes, 'base64')
  const commitHeader = (): Record<string, string> => {
    const members: Record<string, string> = {}
    for (const match of fixture.archive.macHeaders[COVERED]?.matchAll(
      /(\w+)=(?:"([^"]*)"|:([^:]*):|(\d+))/g,
    ) ?? [])
      members[match[1] as string] = (match[2] ?? match[3] ?? match[4]) as string
    return members
  }
  const applyEdit = (archive: Buffer, edit: Edit): Buffer =>
    Buffer.concat([
      archive.subarray(0, edit.at),
      Buffer.from(edit.insert, 'hex'),
      archive.subarray(edit.at + edit.remove),
    ])

  // An independent reading of the framing, so the fixture is checked without
  // trusting the oracle that wrote it or the reader under test.
  interface Pair {
    start: number
    key: Buffer
    valueStart: number
    value: Buffer
  }
  interface Framing {
    metaStart: number
    metaEnd: number
    pairs: Pair[]
    end: number
  }
  const frame = (bytes: Buffer, at: number): [length: number, next: number] => {
    let length = 0
    let width = 0
    for (;;) {
      const byte = bytes[at + width] as number
      length += (byte & 0x7f) * 2 ** (7 * width)
      width += 1
      if (byte < 0x80) return [length, at + width]
    }
  }
  const readFraming = (bytes: Buffer): Framing => {
    expect(bytes.subarray(0, 4).toString('hex')).toBe(MAGIC)
    const [metaLength, metaStart] = frame(bytes, 4)
    const metaEnd = metaStart + metaLength
    const pairs: Pair[] = []
    let at = metaEnd
    while (bytes[at] === 1) {
      const start = at
      const [keyLength, keyStart] = frame(bytes, at + 1)
      const [valueLength, valueStart] = frame(bytes, keyStart + keyLength)
      pairs.push({
        start,
        key: bytes.subarray(keyStart, keyStart + keyLength),
        valueStart: keyStart + keyLength,
        value: bytes.subarray(valueStart, valueStart + valueLength),
      })
      at = valueStart + valueLength
    }
    expect(bytes[at]).toBe(0)
    expect(bytes.length).toBe(at + 1)
    return { metaStart, metaEnd, pairs, end: at }
  }
  const editNamed = (name: string): Edit => {
    const found = fixture.refused.find((edit) => edit.name === name)
    if (!found) throw new Error(`no edit named ${name}`)
    return found
  }
  const recordBytes = (name: string): string => {
    const found = recordFixture.records.find((entry) => entry.name === name)
    return /^accepted ([0-9a-f]+) /.exec(found?.oracle ?? '')?.[1] ?? ''
  }
  const keysOf = (framing: Framing): string[] =>
    framing.pairs.map((pair) => pair.key.toString())

  it('is made by the oracle over a new-form space uri and reproducible', () => {
    expect(fixture.header.classification).toBe('upstream-signed-target-uri')
    expect(fixture.header.upstreamVerified).toBe(true)
    expect(fixture.header.reproducible).toBe(true)
    expect(fixture.header.oracle['additionalPackages']).toEqual([
      expect.objectContaining({ package: '@atproto/lex-json' }),
    ])
  })

  it('stays within the family size limit', () => {
    expect(readFileSync(resolve(FIXTURES_DIR, FILE)).length).toBeLessThan(
      MAX_FAMILY_BYTES,
    )
  })

  it('holds a commit header for the repo and space, and the mac the commit mac vectors would make', () => {
    const header = commitHeader()
    expect(header['ver']).toBe('1')
    expect(header['repo']).toBe(REPO)
    expect(header['space']).toBe(SPACE)
    expect(header['rev']).toMatch(/^[234567a-j][2-7a-z]{12}$/)
    expect(Buffer.from(header['data'] as string, 'base64')).toHaveLength(32)

    const params = /^mac=(.*)$/.exec(macFixture.acceptSignature)?.[1]
    const base = [
      `"${COVERED}";sf: ${fixture.archive.macHeaders[COVERED]}`,
      `"@signature-params": ${params}`,
    ].join('\n')
    const mac = createHmac(
      'sha256',
      Buffer.from(macFixture.sharedSecret.value, 'base64'),
    )
      .update(base)
      .digest('base64')
    expect(fixture.archive.macHeaders['signature']).toBe(`mac=:${mac}:`)
    expect(Object.keys(fixture.archive.macHeaders).sort()).toEqual([
      COVERED,
      'signature',
    ])
  })

  it('holds four records from the record vectors, in strict path order', () => {
    const framing = readFraming(archiveBytes())
    expect(keysOf(framing)).toEqual(RECORDS.map(([, path]) => path))
    expect(framing.pairs.map((pair) => pair.value.toString('hex'))).toEqual(
      RECORDS.map(([name]) => recordBytes(name)),
    )
    const paths = keysOf(framing)
    expect(paths).toEqual([...paths].sort())
    expect(new Set(paths.map((path) => path.split('/')[0])).size).toBe(4)
  })

  it('carries the header commit as the metadata, in front of the records', () => {
    const bytes = archiveBytes()
    const { metaStart, metaEnd } = readFraming(bytes)
    const meta = bytes.subarray(metaStart, metaEnd)
    const header = commitHeader()
    expect(meta.includes(Buffer.from('atproto-space-repo'))).toBe(true)
    for (const member of ['repo', 'space', 'rev'])
      expect(meta.includes(Buffer.from(header[member] as string))).toBe(true)
    expect(meta.includes(Buffer.from(header['data'] as string, 'base64'))).toBe(
      true,
    )
  })

  it('writes the empty repo as the metadata and the end marker alone', () => {
    const bytes = emptyBytes()
    const { metaStart, metaEnd, pairs, end } = readFraming(bytes)
    expect(pairs).toEqual([])
    expect(end).toBe(metaEnd)
    const meta = bytes.subarray(metaStart, metaEnd)
    expect(meta.includes(Buffer.from(lthash.emptyDigest.value, 'base64'))).toBe(
      true,
    )
    expect(meta.includes(Buffer.from(SPACE))).toBe(true)
    expect(meta.includes(Buffer.from(REPO))).toBe(true)
  })

  it('has the oracle accept both archives, and refuse the full one in the new spelling', () => {
    expect(fixture.archive.verdict).toBe(ACCEPTED)
    expect(fixture.empty.verdict).toBe(ACCEPTED)
    expect(fixture.archive.readerOnNewSpelling).toBe(
      'refused: SpaceRepoVerificationError',
    )
  })

  it('holds each required refusal once, with an oracle refusal beside it', () => {
    expect(fixture.refused.map((edit) => edit.name)).toEqual(REQUIRED_REFUSALS)
    for (const edit of fixture.refused)
      expect(edit.verdict, edit.name).toMatch(
        /^refused: (StarParseError|SpaceRepoVerificationError|SpaceMacError)$/,
      )
  })

  it('edits only bytes the archive has and changes the archive', () => {
    const base = archiveBytes()
    for (const edit of fixture.refused) {
      expect(Number.isInteger(edit.at) && edit.at >= 0, edit.name).toBe(true)
      expect(edit.remove >= 0, edit.name).toBe(true)
      expect(edit.at + edit.remove, edit.name).toBeLessThanOrEqual(base.length)
      expect(edit.insert, edit.name).toMatch(/^([0-9a-f]{2})*$/)
      expect(applyEdit(base, edit).equals(base), edit.name).toBe(false)
    }
  })

  it('makes each edit the way its name says', () => {
    const base = archiveBytes()
    const framing = readFraming(base)
    const [first, second, third, fourth] = framing.pairs as [
      Pair,
      Pair,
      Pair,
      Pair,
    ]
    const read = (name: string): Buffer => applyEdit(base, editNamed(name))
    const changedMeta = (name: string): boolean =>
      !read(name)
        .subarray(0, framing.metaEnd)
        .equals(base.subarray(0, framing.metaEnd))

    expect(read('cut before the end marker')).toEqual(
      base.subarray(0, base.length - 1),
    )
    const cutInside = read('cut inside a value')
    expect(cutInside.length).toBeLessThan(base.length)
    expect(cutInside.length).toBeGreaterThan(fourth.valueStart)
    expect(read('an unknown control byte')[first.start]).toBe(2)
    expect(read('one byte after the end')).toEqual(
      Buffer.concat([base, Buffer.from([0])]),
    )

    expect(keysOf(readFraming(read('two records swapped')))).toEqual([
      first.key.toString(),
      second.key.toString(),
      fourth.key.toString(),
      third.key.toString(),
    ])
    const repeated = keysOf(readFraming(read('a record repeated')))
    expect(repeated).toHaveLength(5)
    expect(new Set(repeated).size).toBe(4)

    expect(
      keysOf(readFraming(read('a path that is not collection/rkey'))),
    ).toContain('app.bsky.feed.like.ed')
    const changed = readFraming(read('one value byte changed'))
    expect(changed.pairs.map((pair) => pair.value.length)).toEqual(
      framing.pairs.map((pair) => pair.value.length),
    )
    expect(
      changed.pairs.filter(
        (pair, index) => !pair.value.equals(framing.pairs[index]!.value),
      ),
    ).toHaveLength(1)

    const reencoded = readFraming(
      read('a non-canonical encoding of the record'),
    )
    const post = reencoded.pairs[3]
    expect(post?.value.length).toBe(fourth.value.length)
    expect(post?.value.equals(fourth.value)).toBe(false)
    expect([...(post?.value ?? [])].sort()).toEqual([...fourth.value].sort())

    expect(read('metadata type changed').toString('latin1')).toContain(
      'atproto-space-rexo',
    )
    expect(read('metadata revision changed')).toHaveLength(base.length)
    expect(changedMeta('metadata revision changed')).toBe(true)

    const [metaLimit] = frame(read('a metadata length above the limit'), 4)
    expect(metaLimit).toBe(64 * 1024 + 1)
    const [keyLimit] = frame(
      read('a key length above the limit'),
      first.start + 1,
    )
    expect(keyLimit).toBe(4 * 1024 + 1)
    const valueLimited = read('a value length above the limit, no bytes')
    const [valueLimit, valueBytesAt] = frame(valueLimited, first.valueStart)
    expect(valueLimit).toBe(1024 * 1024 + 1)
    expect(valueLimited).toHaveLength(valueBytesAt)
  })

  it('fails the message authentication only where the commit changed', () => {
    const verdicts = new Map(
      fixture.refused.map((edit) => [edit.name, edit.verdict]),
    )
    expect(verdicts.get('metadata revision changed')).toBe(
      'refused: SpaceMacError',
    )
    expect(verdicts.get('cut before the end marker')).toBe(
      'refused: StarParseError',
    )
    expect(verdicts.get('metadata type changed')).toBe(
      'refused: SpaceRepoVerificationError',
    )
    expect(verdicts.get('two records swapped')).toBe(
      'refused: SpaceRepoVerificationError',
    )
    expect(verdicts.get('a value length above the limit, no bytes')).toBe(
      'refused: StarParseError',
    )
    const macFailures = fixture.refused.filter((edit) =>
      edit.verdict.endsWith('SpaceMacError'),
    )
    expect(macFailures.map((edit) => edit.name)).toEqual([
      'metadata revision changed',
    ])
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
