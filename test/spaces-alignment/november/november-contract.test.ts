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
  'uri-feedgen-migration-v10-verified-state',
  'uri-feed-pagination-cursors',
  'uri-rust-credential-cache',
  'uri-clubhouse-space-map',
  'uri-webapp-inspector',
  'uri-webapp-feed-targets',
  'uri-reply-and-embed-strings',
  'uri-rust-record-uri-callers',
  'uri-service-emitters',
  'uri-service-credential-consumers',
  'uri-clubhouse-topic-route',
  'uri-room-post-references',
  'uri-feed-read-predicates',
  'uri-rust-space-host-requests',
  'uri-lexicon-uri-fields',
  'text-lexicon-legacy-uri-spelling',
  'text-client-and-docs-legacy-uri-spelling',
  'text-docs-legacy-uri-spelling',
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
// /space/ segment but is not a URI, so the earlier spelling is matched only
// after an at:// scheme. The at:space/ marker finds the current spelling, and
// the case-insensitive spaceuri marker also catches spaceUri, SpaceUri,
// parseSpaceUri, formatSpaceUri and boundaryToSpaceUri.
//
// The generic markers find code that handles a space URI under a plain name.
// The at:// prefix check is matched only on a value named as a URI: the
// alsoKnownAs handle readers name theirs aka or atHandle, and they read a
// handle, not a record. A bare startsWith('at://') is not a marker for that
// reason. The column markers name columns that hold record URIs in the
// projection, the backlink index and the label log.
const EARLIER_SPACE_URI = /at:\/\/[^\s'"`]*\/space\//
const CURRENT_SPACE_URI = /at:space\//
const SPACE_URI_MARKERS = [
  EARLIER_SPACE_URI,
  CURRENT_SPACE_URI,
  /spaceuri/i,
  /space_uri/,
  /parseRecordUri/,
  /boundary_to_space_uri/,
  /RecordUri::/,
  /[Uu]ri\??\.(?:startsWith|replace|slice)\(\s*['"`]at:\/\//,
  /(?:strip_prefix|starts_with|trim_start_matches)\("at:\/\/"\)/,
  /ORDER BY[^"\n]*\b(?:[a-z]+\.)?(?:uri|subject_uri|subject_key)\b/,
  /\bsubject_uri\b/,
  /\bsubject_key\b|\bsubjectKey\b/,
  /\blinkTo\b/,
]

// Paths that may still spell a space URI in the earlier at://.../space/...
// form on a line that does not say legacy. Each holds until the work named in
// its reason lands.
const EARLIER_SPELLING_EXEMPTIONS: Record<string, string> = {
  docs: 'prose and examples wait for the cutover documentation work',
  'test/scripts': 'end-to-end scripts wait for the cutover work',
  'test/feedgen-harness': 'the harness waits for the cutover work',
  clubhouse:
    'the room configuration check and its tests wait for the client-flow work',
  'webapp/src/lib/inspector.ts':
    'the record inspector waits for the client-flow work',
  'webapp/tests/inspector.test.ts':
    'the record inspector tests wait for the client-flow work',
  'stratos-feedgen-ng/src/store/migrations.rs':
    'migration tests describe rows an older build wrote, and migrations are not edited',
}

// Files that read, compare or carry a record or space URI. Each must stay
// under the paths of the named row, whether or not a marker matches it, so a
// consumer that uses only generic names cannot drop out of the ledger.
const KNOWN_URI_CONSUMERS: Record<string, string> = {
  'clubhouse/src/lib/route.ts': 'uri-clubhouse-topic-route',
  'clubhouse/src/App.svelte': 'uri-clubhouse-topic-route',
  'clubhouse/src/lib/components/RoomFeed.svelte': 'uri-clubhouse-topic-route',
  'clubhouse/src/lib/feed-authors.ts': 'uri-clubhouse-topic-route',
  'clubhouse/src/lib/post-writer.ts': 'uri-clubhouse-space-map',
  'stratos-client/src/space-uri.ts': 'uri-client-formatter',
  'stratos-feedgen-ng/src/identifier.rs': 'uri-rust-record-uri',
  'stratos-service/src/oauth/handlers/room-post.ts': 'uri-room-post-references',
  'stratos-feedgen-ng/src/store/read.rs': 'uri-feed-read-predicates',
  'stratos-feedgen-ng/src/cursor.rs': 'uri-feed-pagination-cursors',
  'stratos-feedgen-ng/src/server/feed.rs': 'uri-feed-pagination-cursors',
  'stratos-feedgen-ng/src/space_host.rs': 'uri-rust-space-host-requests',
  'stratos-feedgen-ng/src/pds_space_sync.rs': 'uri-rust-space-host-requests',
  'stratos-feedgen-ng/src/space_commit.rs': 'uri-rust-space-host-requests',
  'stratos-feedgen-ng/src/space_mac.rs': 'uri-rust-space-host-requests',
  'stratos-feedgen-ng/src/service_auth.rs': 'uri-rust-space-host-requests',
  'stratos-feedgen-ng/src/label_poller.rs': 'uri-label-page-parsing',
  'stratos-core/src/validation/post-validator.ts':
    'uri-reply-and-embed-strings',
  'stratos-service/src/infra/storage/postgres/actor-store.ts':
    'uri-backlink-keys',
  'stratos-service/src/infra/storage/postgres/record-store.ts':
    'uri-backlink-keys',
  'stratos-service/src/storage/sqlite/actor-store.ts': 'uri-backlink-keys',
  'stratos-service/src/api/records/boundary-writes.ts': 'uri-backlink-keys',
  'stratos-service/src/features/moderation/wire-label.ts':
    'uri-label-log-subjects',
  'stratos-service/src/features/moderation/query-handler.ts':
    'uri-label-log-subjects',
  'webapp/src/lib/feed.ts': 'uri-webapp-feed-targets',
  'lexicons/zone/stratos/feedgen/getFeed.json': 'uri-lexicon-uri-fields',
  'lexicons/zone/stratos/feedgen/getBlob.json': 'uri-lexicon-uri-fields',
  'stratos-core/src/lexicons/vendored/com/atproto/repo/strongRef.json':
    'uri-lexicon-uri-fields',
  'stratos-core/src/lexicons/vendored/app/bsky/embed/record.json':
    'uri-lexicon-uri-fields',
  'test/scripts/test-clubhouse-public-alpha.ts': 'tests-e2e-scripts',
  'test/scripts/lib/mixed-mode-pds.ts': 'tests-e2e-scripts',
  'test/feedgen-harness/compare.ts': 'tests-spike-and-harness',
}

// A cited line is written as path:line or path:start-end, and a later
// ":line" after a space, as in ", :12" or "at :12", continues the last path.
// A bare file name is resolved against the row's own paths, and only when
// one path matches it. A colon after a space never occurs inside a DID.
const LINE_REFERENCE =
  /(?:([\w./-]+\.(?:ts|rs|json|svelte|mjs|lock))|\s):(\d+)(?:-(\d+))?/g

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

function isExemptFromLegacyLines(file: string): boolean {
  return Object.keys(EARLIER_SPELLING_EXEMPTIONS).some((path) =>
    coversPath(path, file),
  )
}

function earlierSpellingWithoutLegacy(file: string): string[] {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8')
    .split('\n')
    .flatMap((line, index) =>
      EARLIER_SPACE_URI.test(line) && !/legacy/i.test(line)
        ? [`${file}:${index + 1}`]
        : [],
    )
}

function isCoveredByRowPath(file: string, rows: LedgerRow[]): boolean {
  return rows.some((row) =>
    (row.paths ?? []).some((path) => coversPath(path, file)),
  )
}

function coversPath(rowPath: string, file: string): boolean {
  return file === rowPath || file.startsWith(`${rowPath.replace(/\/$/, '')}/`)
}

function lineCountOf(file: string): number {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8')
    .replace(/\n$/, '')
    .split('\n').length
}

function resolveCitedFile(cited: string, row: LedgerRow): string | undefined {
  if (cited.includes('/') && existsSync(resolve(REPO_ROOT, cited))) {
    return cited
  }
  const matches = (row.paths ?? []).filter(
    (path) => path === cited || path.endsWith(`/${cited}`),
  )
  return matches.length === 1 ? matches[0] : undefined
}

function lineReferenceProblems(row: LedgerRow): string[] {
  const problems: string[] = []
  for (const text of [row.decision, row.evidence]) {
    let lastFile: string | undefined
    for (const match of text.matchAll(LINE_REFERENCE)) {
      const [, citedFile, startText, endText] = match
      const lines =
        endText === undefined ? startText : `${startText}-${endText}`
      if (citedFile !== undefined) {
        lastFile = resolveCitedFile(citedFile, row)
        if (lastFile === undefined) {
          problems.push(`${row.id}: ${citedFile}:${lines} names no unique file`)
          continue
        }
      }
      if (lastFile === undefined) continue
      const start = Number(startText)
      const end = endText === undefined ? start : Number(endText)
      const length = lineCountOf(lastFile)
      if (start < 1 || end < start || end > length) {
        problems.push(
          `${row.id}: ${lastFile}:${lines} is outside the file (${length} lines)`,
        )
      }
    }
  }
  return problems
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

  it('names the earlier spelling only on lines that say legacy', () => {
    const unnamed = SWEEP_ROOTS.flatMap(sweepFiles)
      .filter((file) => !isExemptFromLegacyLines(file))
      .flatMap(earlierSpellingWithoutLegacy)
    expect(unnamed).toEqual([])
  })

  it('keeps every known uri consumer under the paths of its row', () => {
    const byId = rowsById(rows)
    const lost = Object.entries(KNOWN_URI_CONSUMERS)
      .filter(
        ([file, id]) =>
          !existsSync(resolve(REPO_ROOT, file)) ||
          !(byId.get(id)?.paths ?? []).some((path) => coversPath(path, file)),
      )
      .map(([file, id]) => `${file} -> ${id}`)
    expect(lost).toEqual([])
  })

  it('cites only lines that exist in the cited file', () => {
    const problems = rows.flatMap(lineReferenceProblems)
    expect(problems).toEqual([])
  })

  it('reads both citation forms and their continuations', () => {
    const cursor = 'stratos-feedgen-ng/src/cursor.rs'
    const past = lineCountOf(cursor) + 1
    const citing: LedgerRow = {
      id: 'citation-probe',
      promptSection: 'base',
      surface: 'Spike, Faye and Jet on the Bebop',
      ownership: 'test-owned',
      paths: [cursor],
      workstream: 'none',
      decision: `${cursor}:1-2, :3 and at :${past}`,
      evidence: `cursor.rs:${past}-${past + 1}; bebop/swordfish.rs:1`,
    }
    expect(lineReferenceProblems(citing)).toEqual([
      `citation-probe: ${cursor}:${past} is outside the file (${past - 1} lines)`,
      `citation-probe: ${cursor}:${past}-${past + 1} is outside the file (${past - 1} lines)`,
      'citation-probe: bebop/swordfish.rs:1 names no unique file',
    ])
  })

  it('finds the files that hold the current spelling by its marker', () => {
    const found = SWEEP_ROOTS.flatMap(sweepFiles).filter((file) =>
      CURRENT_SPACE_URI.test(readFileSync(resolve(REPO_ROOT, file), 'utf8')),
    )
    expect(found).toEqual(
      expect.arrayContaining([
        'stratos-core/src/spaces/domain.ts',
        'stratos-client/src/space-uri.ts',
        'stratos-feedgen-ng/src/identifier.rs',
      ]),
    )
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
