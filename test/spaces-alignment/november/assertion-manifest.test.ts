import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { suite as baseline } from '../scenarios/baseline.js'
import { suite as clientCustody } from '../scenarios/client-custody.js'
import { suite as credentialLifetime } from '../scenarios/credential-lifetime.js'
import { suite as delegationTransport } from '../scenarios/delegation-transport.js'
import { suite as feedErrors } from '../scenarios/feed-errors.js'
import { suite as novemberInterop } from '../scenarios/november-interop.js'
import { suite as ordinaryCustody } from '../scenarios/ordinary-custody.js'
import { suite as rustProductionInterop } from '../scenarios/rust-production-interop.js'
import { suite as serviceAdmission } from '../scenarios/service-admission.js'
import { suite as spaceDelete } from '../scenarios/space-delete.js'
import { suite as standardCredentialTransport } from '../scenarios/standard-credential-transport.js'
import { validateSuite } from '../rules.js'
import type { ScenarioSuite } from '../rules.js'
import { ACCEPTANCE_ROWS, JOURNEYS } from './interop-journeys.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(HERE, '../../..')

// Every assertion id of every suite as the series began, held here so that a
// manifest edit cannot shrink the list it is checked against.
const ASSERTIONS_AT_THE_START: Record<string, string[]> = {
  baseline: [
    'browser-oauth',
    'stratos-custody',
    'pds-custody',
    'space-lexicon',
    'pds-space-grant',
    'publication-feed',
    'boundary-isolation',
    'unrelated-boundary-denied',
    'public-private-blob-denied',
    'authenticated-space-blob',
  ],
  'client-custody': [
    'sdk-discovers-both-custodies',
    'authority-and-host-agree',
    'selected-space-write',
    'space-write-is-private',
    'unresolved-custody-sends-no-credentials',
  ],
  'credential-lifetime': [
    'oauth-space-session',
    'pds-issued-delegation',
    'credential-minted',
    'local-read-before-removal',
    'foreign-read-before-removal',
    'member-removed',
    'local-credential-after-removal',
    'foreign-credential-after-removal',
    'wrong-key-denied',
    'expired-local-credential-denied',
    'local-revision-denied',
    'local-deactivation-denied',
  ],
  'credential-revocation-contract': [
    'upstream-two-grants-read',
    'upstream-wrong-issuer-denied',
    'upstream-foreign-audience-denied',
    'upstream-service-audience-denied',
    'upstream-wrong-method-denied',
    'upstream-missing-method-denied',
    'upstream-malformed-batch-denied',
    'upstream-cross-space-isolation',
    'upstream-grant-a-revoked-b-unaffected',
    'upstream-duplicate-idempotence',
    'upstream-restart-retention',
    'stratos-unsupported-route',
    'stratos-unsupported-role-unadvertised',
  ],
  'delegation-transport': [
    'oauth-space-session',
    'authorization-server-pds-separation',
    'pds-issued-delegation',
    'header-exchange',
    'foreign-repo-read',
    'tampered-delegation-signature-denied',
    'wrong-key-denied',
    'delegation-replay-denied',
    'missing-proof-preserves-delegation',
    'ambiguous-transport-denied',
    'ordinary-bearer-denied',
  ],
  'feed-errors': [
    'private-feed-loaded',
    'interrupted-feed-error',
    'public-feed-retained',
    'retry-recovered',
    'revoked-session-cleared',
    'late-response-isolated',
  ],
  'october-interop': [
    'standard-exchange',
    'stratos-read',
    'october-pds-read',
    'two-owners-one-host',
    'wrong-owner-denied',
    'wrong-key-denied',
    'tampered-token-denied',
    'same-signature-reused',
    'default-lifetime-600',
    'renewal-fresh-key',
    'renewal-after-removal-denied',
    'cross-space-denied',
    'legacy-compatible',
    'conflicting-proof-denied',
    'delegation-replay-denied',
    'rust-second-owner-ingestion',
    'rust-manager-expiry-refresh',
    'rust-standard-exchange',
    'rust-stratos-read',
    'rust-october-pds-read',
    'rust-two-owners-one-host',
    'rust-wrong-owner-denied',
    'rust-wrong-key-denied',
    'rust-same-signature-reused',
    'rust-renewal-fresh-key',
    'rust-renewal-after-removal-denied',
  ],
  'pds-revocation': [
    'late-page-revoked',
    'late-terminal-verification-revoked',
    'other-member-preserved',
    'old-generation-rejection-observed',
    'fresh-generation-recovers',
    'restart-keeps-revocation',
  ],
  'rust-production-interop': [
    'rust-second-owner-ingestion',
    'rust-manager-expiry-refresh',
    'rust-standard-exchange',
    'rust-stratos-read',
    'rust-october-pds-read',
    'rust-two-owners-one-host',
    'rust-wrong-owner-denied',
    'rust-wrong-key-denied',
    'rust-same-signature-reused',
    'rust-renewal-fresh-key',
    'rust-renewal-after-removal-denied',
  ],
  'service-admission': [
    'never-enrolled-denied',
    'active-all-boundary',
    'active-assigned-pull-records',
    'active-second-boundary',
    'foreign-boundary-pull-denied',
    'deactivated-denied',
    'reactivated-admitted',
  ],
  'space-delete': [
    'webapp-oauth-delete-grant',
    'pds-delete-target',
    'feed-removes-only-target',
    'other-author-denied',
    'stratos-delete-preserved',
  ],
  'staging-limits': [
    'cumulative-pass-budget',
    'same-path-replacement-and-delete-accounting',
    'rejected-page-transaction-rollback',
    'promotion-replaces-staged-accounting',
    'unrelated-target-remains-available',
    'multi-target-global-budget',
    'persisted-storage-accounting',
    'target-row-budget',
    'global-row-budget',
    'service-responsive',
    'interrupted-stage',
    'expired-stage-restart',
  ],
  'standard-credential-transport': [
    'standard-exchange',
    'stratos-read',
    'october-pds-read',
    'two-owners-one-host',
    'wrong-owner-denied',
    'wrong-key-denied',
    'tampered-token-denied',
    'same-signature-reused',
    'default-lifetime-600',
    'renewal-fresh-key',
    'renewal-after-removal-denied',
    'cross-space-denied',
    'legacy-compatible',
    'conflicting-proof-denied',
    'delegation-replay-denied',
  ],
  'writer-sync-contract': [
    'upstream-commit-rev-unchanged',
    'upstream-short-page-cursor',
    'upstream-exclusive-empty-preserves-checkpoint',
    'upstream-repeated-writer-new-state',
    'upstream-equal-older-idempotent',
    'upstream-wrong-issuer-denied',
    'upstream-wrong-audience-denied',
    'upstream-future-revision-denied',
    'upstream-current-write-policy-denied',
    'stratos-standard-writer-routes-unsupported',
  ],
}

const SURVIVING_SUITES: Record<string, ScenarioSuite> = Object.fromEntries(
  [
    baseline,
    clientCustody,
    credentialLifetime,
    delegationTransport,
    feedErrors,
    rustProductionInterop,
    serviceAdmission,
    spaceDelete,
    standardCredentialTransport,
  ].map((suite) => [suite.id, suite]),
)

type Carrier =
  | { kind: 'suite-assertion'; suite: string; id: string }
  | { kind: 'test'; file: string; title: string; proves?: string }
  | { kind: 'journey'; name: string }
  | { kind: 'none' }

interface Entry {
  suite: string
  id: string
  disposition: 'retained' | 'renamed' | 'superseded' | 'uncovered'
  renamedTo?: string
  carriedBy: Carrier[]
  reason: string
}

const manifest = JSON.parse(
  readFileSync(resolve(HERE, 'assertion-manifest.json'), 'utf8'),
) as { entries: Entry[] }

const entryName = (suite: string, id: string) => `${suite}:${id}`

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A title must match a declaration, not any text: a title that is a prefix of
// another test's title would otherwise survive the deletion of its own test.
function declaresTest(source: string, file: string, title: string): boolean {
  const name = escapeRegExp(title)
  const declaration = file.endsWith('.rs')
    ? new RegExp(`\\bfn ${name}\\(`)
    : new RegExp(
        `\\b(?:it|test)(?:\\.each\\((?:[^()]|\\([^()]*\\))*\\))?\\(\\s*(['"\`])${name}\\1`,
      )
  return declaration.test(source)
}

function carrierProblems(entry: Entry, carrier: Carrier): string[] {
  const name = entryName(entry.suite, entry.id)
  switch (carrier.kind) {
    case 'suite-assertion': {
      const problems: string[] = []
      const live = SURVIVING_SUITES[carrier.suite]
      if (!live?.requiredAssertions.includes(carrier.id))
        problems.push(
          `${name} maps to ${entryName(carrier.suite, carrier.id)}, which no suite requires`,
        )
      if (entry.disposition === 'renamed' && carrier.id !== entry.renamedTo)
        problems.push(
          `${name} renamed to ${entry.renamedTo} but maps to ${carrier.id}`,
        )
      if (entry.disposition === 'retained' && carrier.id !== entry.id)
        problems.push(`${name} is retained but maps to ${carrier.id}`)
      return problems
    }
    case 'test': {
      const problems: string[] = []
      if (entry.disposition === 'uncovered')
        problems.push(`${name} is uncovered but names a test`)
      if (!carrier.proves?.trim())
        problems.push(
          `${name} names ${carrier.title} without saying what its body proves`,
        )
      const path = resolve(REPOSITORY_ROOT, carrier.file)
      if (!existsSync(path))
        return [...problems, `${name} names a missing file ${carrier.file}`]
      if (
        !declaresTest(readFileSync(path, 'utf8'), carrier.file, carrier.title)
      )
        problems.push(
          `${name} names a test title not in ${carrier.file}: ${carrier.title}`,
        )
      return problems
    }
    case 'journey':
      return JOURNEYS.some((journey) => journey.id === carrier.name)
        ? []
        : [`${name} names an unknown journey ${carrier.name}`]
    case 'none':
      return entry.disposition === 'superseded' &&
        entry.reason.includes('nothing to port to')
        ? []
        : [`${name} maps to nothing without saying nothing to port to`]
  }
}

function problemsOf(entries: Entry[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const name = entryName(entry.suite, entry.id)
    if (seen.has(name)) problems.push(`duplicate entry ${name}`)
    seen.add(name)
  }
  for (const [suite, ids] of Object.entries(ASSERTIONS_AT_THE_START)) {
    for (const id of ids)
      if (!seen.has(entryName(suite, id)))
        problems.push(`no entry for ${entryName(suite, id)}`)
  }
  for (const entry of entries) {
    const name = entryName(entry.suite, entry.id)
    if (!ASSERTIONS_AT_THE_START[entry.suite]?.includes(entry.id))
      problems.push(`${name} is not an assertion of the start`)
    if (entry.reason.trim() === '') problems.push(`${name} has no reason`)
    if (entry.carriedBy.length === 0) problems.push(`${name} maps to nothing`)
    if (
      entry.disposition === 'uncovered' &&
      !(
        entry.carriedBy.every((carrier) => carrier.kind === 'journey') &&
        entry.reason.startsWith('Not covered today.')
      )
    )
      problems.push(
        `${name} is uncovered but is not carried by journeys alone with a reason that says so`,
      )
    if (entry.disposition === 'renamed' && !entry.renamedTo)
      problems.push(`${name} is renamed without a new name`)
    if (entry.disposition !== 'renamed' && entry.renamedTo)
      problems.push(`${name} names a new name but is not renamed`)
    if (
      (entry.disposition === 'retained' || entry.disposition === 'renamed') &&
      !(
        entry.carriedBy.length === 1 &&
        entry.carriedBy[0]!.kind === 'suite-assertion'
      )
    )
      problems.push(`${name} must map to exactly one suite assertion`)
    for (const carrier of entry.carriedBy)
      problems.push(...carrierProblems(entry, carrier))
  }
  return problems
}

function entryFor(id: string, suite?: string): Entry {
  const found = manifest.entries.find(
    (entry) =>
      entry.id === id && (suite === undefined || entry.suite === suite),
  )
  if (!found) throw new Error(`no entry for ${id}`)
  return found
}

describe('assertion manifest', () => {
  it('accounts for every assertion of every suite at the start of the series', () => {
    expect(problemsOf(manifest.entries)).toEqual([])
  })

  it('lists exactly the 149 assertions of the start, 67 of them from deleted suites', () => {
    expect(Object.values(ASSERTIONS_AT_THE_START).flat()).toHaveLength(149)
    expect(manifest.entries).toHaveLength(149)
    const deleted = Object.entries(ASSERTIONS_AT_THE_START)
      .filter(([suite]) => !(suite in SURVIVING_SUITES))
      .flatMap(([, ids]) => ids)
    expect(deleted).toHaveLength(67)
  })

  it('counts its dispositions', () => {
    const count = (disposition: string) =>
      manifest.entries.filter((entry) => entry.disposition === disposition)
        .length
    expect([
      count('retained'),
      count('renamed'),
      count('superseded'),
      count('uncovered'),
    ]).toEqual([102, 4, 42, 1])
  })

  it('counts the entries nothing in the repository carries', () => {
    const carriedByNothing = manifest.entries.filter((entry) =>
      entry.carriedBy.every((carrier) => carrier.kind === 'none'),
    )
    expect(carriedByNothing).toHaveLength(19)
    expect(new Set(carriedByNothing.map((entry) => entry.suite))).toEqual(
      new Set(['credential-revocation-contract', 'writer-sync-contract']),
    )
  })

  it('keeps all ten mandatory baseline assertions retained under their names', () => {
    expect(ASSERTIONS_AT_THE_START.baseline).toHaveLength(10)
    for (const id of ASSERTIONS_AT_THE_START.baseline!)
      expect(entryFor(id, 'baseline').disposition, id).toBe('retained')
  })

  it('keeps every privacy assertion of the surviving suites', () => {
    for (const id of [
      'boundary-isolation',
      'unrelated-boundary-denied',
      'public-private-blob-denied',
      'authenticated-space-blob',
      'wrong-owner-denied',
      'cross-space-denied',
      'foreign-boundary-pull-denied',
      'other-author-denied',
    ]) {
      const entry = manifest.entries.find(
        (candidate) =>
          candidate.id === id && candidate.suite in SURVIVING_SUITES,
      )
      expect(entry?.disposition, id).toBe('retained')
    }
  })

  it('names the two renamed assertions and the one dropped for dual acceptance', () => {
    const renamed = manifest.entries
      .filter(
        (entry) =>
          entry.disposition === 'renamed' && entry.suite in SURVIVING_SUITES,
      )
      .map((entry) => [entry.suite, entry.id, entry.renamedTo])
    expect(renamed).toHaveLength(2)
    expect(renamed).toContainEqual([
      'standard-credential-transport',
      'october-pds-read',
      'reference-pds-read',
    ])
    expect(renamed).toContainEqual([
      'rust-production-interop',
      'rust-october-pds-read',
      'rust-reference-pds-read',
    ])
    const dropped = entryFor(
      'legacy-compatible',
      'standard-credential-transport',
    )
    expect(dropped.disposition).toBe('superseded')
    expect(dropped.reason).toContain('no dual acceptance')
  })

  it('fails when the entry of one privacy assertion is removed', () => {
    const without = manifest.entries.filter(
      (entry) => entry.id !== 'boundary-isolation',
    )
    expect(problemsOf(without)).toContain(
      'no entry for baseline:boundary-isolation',
    )
  })

  it('fails when a named test title is not in the named file', () => {
    const entries = structuredClone(manifest.entries)
    const entry = entries.find(
      (candidate) => candidate.id === 'late-page-revoked',
    )!
    ;(entry.carriedBy[0] as { title: string }).title = 'a_test_nobody_wrote'
    expect(problemsOf(entries).join('\n')).toContain('a_test_nobody_wrote')
  })

  it('fails when a named test title is only the prefix of a declared test', () => {
    for (const [id, prefix] of [
      ['interrupted-stage', 'a_promotion_that_never_commits_leaves_nothing'],
      ['stratos-standard-writer-routes-unsupported', 'answers them as unknown'],
    ]) {
      const entries = structuredClone(manifest.entries)
      const entry = entries.find((candidate) => candidate.id === id)!
      ;(entry.carriedBy[0] as { title: string }).title = prefix!
      expect(problemsOf(entries).join('\n'), id).toContain(
        `names a test title not in ${(entry.carriedBy[0] as { file: string }).file}: ${prefix}`,
      )
    }
  })

  it('matches a declaration by its exact title, placeholders included', () => {
    const source = [
      "it.each(ROUTES)(\n  'answers $nsid as an unknown method',",
      'test.each([[1, 2]])("adds %s and %s", () => {})',
      "  it(`reads Faye's record`, async () => {})",
      'async fn spike_reads_the_bebop_log() {}',
    ].join('\n')
    expect(
      declaresTest(source, 'a.test.ts', 'answers $nsid as an unknown method'),
    ).toBe(true)
    expect(declaresTest(source, 'a.test.ts', 'adds %s and %s')).toBe(true)
    expect(declaresTest(source, 'a.test.ts', "reads Faye's record")).toBe(true)
    expect(declaresTest(source, 'a.rs', 'spike_reads_the_bebop_log')).toBe(true)
    expect(declaresTest(source, 'a.test.ts', 'answers $nsid')).toBe(false)
    expect(declaresTest(source, 'a.test.ts', 'adds %s')).toBe(false)
    expect(declaresTest(source, 'a.rs', 'spike_reads_the_bebop')).toBe(false)
    expect(declaresTest(source, 'a.rs', 'reads_the_bebop_log')).toBe(false)
  })

  it('fails when a named test file does not exist', () => {
    const entries = structuredClone(manifest.entries)
    const entry = entries.find(
      (candidate) => candidate.id === 'late-page-revoked',
    )!
    ;(entry.carriedBy[0] as { file: string }).file =
      'stratos-feedgen-ng/src/nowhere.rs'
    expect(problemsOf(entries).join('\n')).toContain('missing file')
  })

  it('fails when a named test does not say what its body proves', () => {
    for (const proves of [undefined, '', '  ']) {
      const entries = structuredClone(manifest.entries)
      const carrier = entries.find(
        (candidate) => candidate.id === 'restart-keeps-revocation',
      )!.carriedBy[0] as { proves?: string; title: string }
      carrier.proves = proves
      expect(problemsOf(entries).join('\n')).toContain(
        `names ${carrier.title} without saying what its body proves`,
      )
    }
  })

  it('names each assertion no current test covers, carried only by a journey', () => {
    const uncovered = manifest.entries
      .filter((entry) => entry.disposition === 'uncovered')
      .map((entry) => [
        entryName(entry.suite, entry.id),
        entry.carriedBy.map((carrier) => carrier.kind),
      ])
    expect(uncovered).toEqual([
      ['staging-limits:service-responsive', ['journey']],
    ])
  })

  it('lists each uncovered assertion and its journey in the checklist', () => {
    const checklist = readFileSync(resolve(HERE, 'INTEROP.md'), 'utf8')
    const section = checklist.slice(
      checklist.indexOf('## Not covered by any test today'),
      checklist.indexOf('## 2. The day a host accepts the new spelling'),
    )
    for (const entry of manifest.entries.filter(
      (candidate) => candidate.disposition === 'uncovered',
    )) {
      expect(section).toContain('`' + entry.suite + ':' + entry.id + '`')
      for (const carrier of entry.carriedBy)
        if (carrier.kind === 'journey')
          expect(section).toContain('`' + carrier.name + '`')
    }
  })

  it('fails when an uncovered entry names a test or does not say it is uncovered', () => {
    const naming = structuredClone(manifest.entries)
    naming
      .find((candidate) => candidate.id === 'service-responsive')!
      .carriedBy.push({
        kind: 'test',
        file: 'stratos-feedgen-ng/src/server/tests.rs',
        title: 'health_starts_unavailable',
        proves: 'The health route answers 503 before a session exists.',
      })
    expect(problemsOf(naming).join('\n')).toContain(
      'is uncovered but names a test',
    )
    const silent = structuredClone(manifest.entries)
    silent.find((candidate) => candidate.id === 'service-responsive')!.reason =
      'A journey runs it.'
    expect(problemsOf(silent).join('\n')).toContain(
      'is uncovered but is not carried by journeys alone',
    )
  })

  it('fails when a superseded entry maps to nothing without saying so', () => {
    const entries = structuredClone(manifest.entries)
    const entry = entries.find(
      (candidate) => candidate.id === 'upstream-restart-retention',
    )!
    entry.reason = 'It was probed once.'
    expect(problemsOf(entries).join('\n')).toContain(
      'without saying nothing to port to',
    )
  })

  it('fails when a retained assertion is not required by any suite', () => {
    const entries = structuredClone(manifest.entries)
    const entry = entries.find(
      (candidate) =>
        candidate.suite === 'feed-errors' && candidate.id === 'retry-recovered',
    )!
    ;(entry.carriedBy[0] as { id: string }).id = 'retry-forgotten'
    expect(problemsOf(entries).join('\n')).toContain('which no suite requires')
  })
})

describe('november-interop suite', () => {
  it('is a valid suite whose assertions are the journeys, one name each', () => {
    expect(() => validateSuite(novemberInterop)).not.toThrow()
    expect(novemberInterop.requiredAssertions).toEqual(
      JOURNEYS.map((journey) => journey.id),
    )
  })

  it('has the journeys the plan names', () => {
    const ids = JOURNEYS.map((journey) => journey.id)
    for (const id of [
      'membership-revoked-mid-poll',
      'non-member-forged-boundary-write-never-indexed',
      'host-does-not-authorize-write-against-authority',
    ])
      expect(ids).toContain(id)
  })

  it('names an acceptance row for every journey', () => {
    for (const journey of JOURNEYS) {
      expect(Object.keys(ACCEPTANCE_ROWS), journey.id).toContain(
        journey.acceptanceRow,
      )
      expect(ACCEPTANCE_ROWS[journey.acceptanceRow].length).toBeGreaterThan(0)
    }
  })

  it('names a real suite for every journey a suite is said to carry', () => {
    const known = new Set([
      ...Object.keys(SURVIVING_SUITES),
      ordinaryCustody.id,
    ])
    for (const journey of JOURNEYS)
      for (const id of journey.carriedBy)
        expect(known.has(id), `${journey.id}: ${id}`).toBe(true)
  })

  it('refuses to run while the November manifest is not ready', async () => {
    await expect(
      novemberInterop.run({
        sandboxDirectory: '/tmp/faye-sandbox',
        composeFile: '/tmp/faye-sandbox/compose.yaml',
        projectName: 'faye-test',
        scratchDirectory: '/tmp/faye-report',
        runCommand: async () => {
          throw new Error('nothing may run')
        },
      }),
    ).rejects.toThrow('refuses to run until the November manifest is ready')
  })
})
