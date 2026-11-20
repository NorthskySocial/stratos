import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const LEDGER_PATH = resolve(HERE, 'applicability.json')

const OWNERSHIPS = [
  'production-owned',
  'test-owned',
  'external-library-owned',
  'absent',
] as const
const WORKSTREAMS = [
  'canonical-uri',
  'credential-transport',
  'response-authentication',
  'verified-state',
  'sync-recovery',
  'schemas-and-clients',
  'interop-cutover',
  'none',
] as const

interface LedgerRow {
  id: string
  promptSection: string
  surface: string
  ownership: string
  paths: string[]
  workstream: string
  decision: string
  evidence: string
}

const PROMPT_SECTION_IDS = [
  'prompt-1a-method-renames',
  'prompt-1b-field-renames',
  'prompt-1c-error-renames',
  'prompt-1d-star-content-type',
  'prompt-1e-space-meta-archives',
  'prompt-2a-member-lists',
  'prompt-2b-managing-apps',
  'prompt-2c-allowed-apps',
  'prompt-3-declarations-and-scopes',
  'prompt-4a-credentials',
  'prompt-4b-registration',
  'prompt-4c-notifications',
  'prompt-4d-repo-host-notify',
  'prompt-4e-space-host-registrations',
  'prompt-5-credential-signatures',
  'prompt-6a-shared-secret',
  'prompt-6b-mac-request',
  'prompt-6c-mac-response',
  'prompt-6d-mac-verification',
  'prompt-6e-repo-host-mac',
  'prompt-7a-writer-removal',
  'prompt-7b-list-repo-ops-commit',
  'prompt-7c-garbage-collection',
  'prompt-7d-space-host-sequencing',
  'prompt-8-moderation-guidance',
  'prompt-9-api-library',
  'prompt-9-lex-bindings',
  'prompt-9-space-package',
  'prompt-9-syntax',
  'prompt-9-oauth-scopes',
  'prompt-9-crypto-did',
  'prompt-9-repo-car',
  'prompt-9-lex-space',
  'prompt-10-reference-pds-deployment',
  'prompt-11-verify-and-report',
]

const MAC_SECTION_IDS = [
  'prompt-6a-shared-secret',
  'prompt-6b-mac-request',
  'prompt-6c-mac-response',
  'prompt-6d-mac-verification',
  'prompt-6e-repo-host-mac',
]

const PREREQUISITE_IDS = [
  'prerequisite-lthash-commit',
  'prerequisite-prev-cid-ops',
  'prerequisite-terminal-revision',
  'prerequisite-star-framing',
  'prerequisite-token-audience',
  'prerequisite-kem-key-discovery',
]

const CUSTOM_CONTRACT_IDS = [
  'custom-zone-space-list-repos',
  'custom-zone-space-get-space-credential',
  'custom-zone-space-get-record',
  'custom-zone-space-list-blobs',
  'custom-zone-repo-boundary-writes',
  'custom-zone-sync-methods',
]

const URI_INVENTORY_IDS = [
  'uri-core-parser-formatter',
  'uri-client-formatter',
  'uri-subject-checks',
  'uri-subject-resolver',
  'uri-validation-copy-rewrite',
  'uri-backlink-keys',
  'uri-label-log-subjects',
  'uri-moderation-subject-parser',
  'uri-service-credential-subjects',
  'uri-rust-record-uri',
  'uri-rust-space-uri-checks',
  'uri-interaction-index',
  'uri-takedown-set',
  'uri-label-page-parsing',
  'uri-feedgen-migration-v1-projection-core',
  'uri-feedgen-migration-v2-boundary-columns',
  'uri-feedgen-migration-v3-actor-enrollment',
  'uri-feedgen-migration-v4-enrollment-index',
  'uri-feedgen-migration-v5-stage-cursor',
  'uri-feedgen-migration-v6-pds-generations',
  'uri-feedgen-migration-v7-stage-lifetime',
  'uri-feedgen-migration-v8-label-subjects',
  'uri-feedgen-migration-v9-interactions',
  'uri-feed-pagination-cursors',
  'uri-rust-credential-cache',
  'uri-clubhouse-space-map',
  'uri-webapp-inspector',
  'uri-webapp-feed-targets',
  'uri-reply-and-embed-strings',
  'uri-rust-record-uri-callers',
  'uri-service-emitters',
  'uri-service-credential-consumers',
  'text-lexicon-legacy-uri-spelling',
  'text-client-and-docs-legacy-uri-spelling',
  'tests-package-uri-literals',
  'tests-rust-uri-literals',
]

// Where a space URI can be parsed, formatted, emitted, stored or compared.
// Every file under these roots that holds one of the markers must fall under
// a ledger row's path, so a new consumer cannot appear without a decision.
const SWEEP_ROOTS = [
  'stratos-core',
  'stratos-service',
  'stratos-client',
  'stratos-browser',
  'stratos-feedgen-ng',
  'webapp',
  'clubhouse',
  'lexicons',
  'lexicons-spaces',
  'test/scripts',
  'test/feedgen-harness',
  'docs',
]
const SWEEP_SKIPPED_DIRECTORY = /^(node_modules|target|dist|build|\..*)$/
const SWEEP_TEXT_FILE = /\.(ts|tsx|js|mjs|svelte|rs|json|md|sql|toml)$/
// A repository path such as lexicons/zone/stratos/space/feed.json has a
// /space/ segment but is not a URI, so the legacy form is matched only after
// an at:// scheme. The case-insensitive spaceuri marker also catches
// spaceUri, SpaceUri, parseSpaceUri, formatSpaceUri and boundaryToSpaceUri.
const SPACE_URI_MARKERS = [
  /at:\/\/[^\s'"`]*\/space\//,
  /spaceuri/i,
  /space_uri/,
  /parseRecordUri/,
  /boundary_to_space_uri/,
  /RecordUri::/,
]

const DEPENDENCY_IMPORTER_IDS = [
  'dependency-oauth-scopes-importer',
  'dependency-scope-check-caller',
]

const SUPPORTING_IDS = [
  'tests-aiab-scenarios',
  'tests-spike-and-harness',
  'tests-e2e-scripts',
  'deno-lock-pins-retired-oauth-scopes',
  'deprecated-stratos-feedgen',
  'deprecated-stratos-indexer',
  'deprecated-atproto-stratos',
]

const REQUIRED_IDS = [
  ...PROMPT_SECTION_IDS,
  ...PREREQUISITE_IDS,
  ...CUSTOM_CONTRACT_IDS,
  ...URI_INVENTORY_IDS,
  ...DEPENDENCY_IMPORTER_IDS,
  ...SUPPORTING_IDS,
]

const DEPRECATED_IDS = [
  'deprecated-stratos-feedgen',
  'deprecated-stratos-indexer',
  'deprecated-atproto-stratos',
]

function sweepFiles(directory: string): string[] {
  return readdirSync(resolve(REPO_ROOT, directory), { withFileTypes: true })
    .filter((entry) => !SWEEP_SKIPPED_DIRECTORY.test(entry.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return sweepFiles(path)
      return SWEEP_TEXT_FILE.test(entry.name) ? [path] : []
    })
}

function isCoveredByRowPath(file: string, rows: LedgerRow[]): boolean {
  return rows.some((row) =>
    (row.paths ?? []).some(
      (path) => file === path || file.startsWith(`${path.replace(/\/$/, '')}/`),
    ),
  )
}

function loadRows(): LedgerRow[] {
  const parsed = JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) as {
    rows?: LedgerRow[]
  }
  return parsed.rows ?? []
}

function idsOf(rows: LedgerRow[]): string[] {
  return rows.map((row) => row.id)
}

function rowsById(rows: LedgerRow[]): Map<string, LedgerRow> {
  return new Map(rows.map((row) => [row.id, row]))
}

describe('november applicability ledger', () => {
  const rows = loadRows()
  const present = new Set(idsOf(rows))

  it('lists every required surface, naming what is missing', () => {
    const missing = REQUIRED_IDS.filter((id) => !present.has(id))
    expect(missing).toEqual([])
  })

  it('has every message-authentication section of the migration prompt', () => {
    const missing = MAC_SECTION_IDS.filter((id) => !present.has(id))
    expect(missing).toEqual([])
  })

  it('has every uri and persisted-state surface', () => {
    const missing = URI_INVENTORY_IDS.filter((id) => !present.has(id))
    expect(missing).toEqual([])
  })

  it('has no duplicate ids', () => {
    const seen = new Set<string>()
    const duplicates = idsOf(rows).filter((id) => {
      const repeated = seen.has(id)
      seen.add(id)
      return repeated
    })
    expect(duplicates).toEqual([])
  })

  it('uses stable kebab-case ids', () => {
    const malformed = idsOf(rows).filter(
      (id) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id),
    )
    expect(malformed).toEqual([])
  })

  it('uses only known ownership and workstream values', () => {
    const badOwnership = rows
      .filter(
        (row) => !(OWNERSHIPS as readonly string[]).includes(row.ownership),
      )
      .map((row) => `${row.id}: ${row.ownership}`)
    const badWorkstream = rows
      .filter(
        (row) => !(WORKSTREAMS as readonly string[]).includes(row.workstream),
      )
      .map((row) => `${row.id}: ${row.workstream}`)
    expect(badOwnership).toEqual([])
    expect(badWorkstream).toEqual([])
  })

  it('gives every row a section, surface, decision and evidence', () => {
    const incomplete = rows
      .filter((row) =>
        [row.promptSection, row.surface, row.decision, row.evidence].some(
          (field) => typeof field !== 'string' || field.trim() === '',
        ),
      )
      .map((row) => row.id)
    expect(incomplete).toEqual([])
  })

  it('points every path at a file or directory that exists', () => {
    const missing = rows.flatMap((row) =>
      (row.paths ?? [])
        .filter((path) => !existsSync(resolve(REPO_ROOT, path)))
        .map((path) => `${row.id}: ${path}`),
    )
    expect(missing).toEqual([])
  })

  it('marks a row absent if and only if it has no paths', () => {
    const inconsistent = rows
      .filter(
        (row) =>
          (row.ownership === 'absent') !== ((row.paths ?? []).length === 0),
      )
      .map((row) => row.id)
    expect(inconsistent).toEqual([])
  })

  it('assigns a workstream to owned surfaces unless they are custom or deprecated', () => {
    const undecided = rows
      .filter(
        (row) =>
          (row.ownership === 'production-owned' ||
            row.ownership === 'test-owned') &&
          row.workstream === 'none' &&
          !row.decision.startsWith('custom, not renamed') &&
          !row.decision.startsWith('deprecated'),
      )
      .map((row) => row.id)
    expect(undecided).toEqual([])
  })

  it('keeps the custom zone.stratos contracts production-owned and unrenamed', () => {
    const byId = rowsById(rows)
    const wrong = CUSTOM_CONTRACT_IDS.filter((id) => {
      const row = byId.get(id)
      return (
        row === undefined ||
        row.ownership !== 'production-owned' ||
        !row.decision.startsWith('custom, not renamed')
      )
    })
    expect(wrong).toEqual([])
  })

  it('marks the deprecated packages as not a target', () => {
    const byId = rowsById(rows)
    const wrong = DEPRECATED_IDS.filter((id) => {
      const row = byId.get(id)
      return (
        row === undefined ||
        !row.decision.startsWith('deprecated, not a target')
      )
    })
    expect(wrong).toEqual([])
  })

  it('names the oauth-scopes importer before any dependency edit', () => {
    const importer = rowsById(rows).get('dependency-oauth-scopes-importer')
    expect(importer?.paths).toContain(
      'stratos-service/src/oauth/spaces-capability.ts',
    )
    const caller = rowsById(rows).get('dependency-scope-check-caller')
    expect(caller?.paths).toContain(
      'stratos-service/src/api/records/scope-check.ts',
    )
  })

  it('records each earlier-release prerequisite the base lacks', () => {
    const byId = rowsById(rows)
    const wrong = PREREQUISITE_IDS.filter((id) => {
      const row = byId.get(id)
      return (
        row === undefined ||
        !row.promptSection.startsWith('prerequisite:') ||
        row.ownership === 'external-library-owned'
      )
    })
    expect(wrong).toEqual([])
  })

  it('covers every file that holds a space uri marker with a row path', () => {
    const uncovered = SWEEP_ROOTS.flatMap(sweepFiles)
      .filter((file) => {
        const text = readFileSync(resolve(REPO_ROOT, file), 'utf8')
        return SPACE_URI_MARKERS.some((marker) => marker.test(text))
      })
      .filter((file) => !isCoveredByRowPath(file, rows))
    expect(uncovered.join('\n')).toBe('')
  })

  it('finds the known consumers the sweep must never lose', () => {
    const found = SWEEP_ROOTS.flatMap(sweepFiles)
    expect(found).toEqual(
      expect.arrayContaining([
        'stratos-core/src/spaces/domain.ts',
        'stratos-feedgen-ng/src/space_membership.rs',
        'docs/architecture/spaces-alignment.md',
      ]),
    )
  })
})
