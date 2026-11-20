import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const MANIFEST_PATH = resolve(HERE, 'sources.json')

const TARGET_URI_FORMAT = 'at:space/'

const PROMPT_FILES = [
  'prompt-11-12-26.md',
  'prompt-11-5-26.md',
  'prompt-10-29-26.md',
  'prompt-10-22-26.md',
]
const MIGRATION_PROMPT = 'prompt-11-12-26.md'
const LEDGER_PATH = resolve(HERE, 'applicability.json')
const PACKAGE_NAMES = [
  '@atproto/api',
  '@atproto/syntax',
  '@atproto/oauth-scopes',
  '@atproto/space',
  '@atproto/lexicon',
  '@atproto/oauth-client-node',
]
const SELECTIONS = ['selected', 'inspected-not-selected']

// Artifacts known to serialize the legacy at://{did}/space/ form. Held here
// on purpose so a manifest edit cannot shrink the list.
const LEGACY_REVISIONS = [
  'b5fd12fa57b10cf068efa879812f558780f37109',
  'd4def6e9f521896ed8222f576d54923d00b5fbeb',
]
const LEGACY_PACKAGE_VERSIONS = [
  '0.0.0-spaces-alpha-20261117141222',
  '0.0.0-spaces-alpha-20261112204144',
]

const HEX_40 = /^[0-9a-f]{40}$/
const HEX_64 = /^[0-9a-f]{64}$/
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

interface UriProbe {
  artifactRevision?: string
  imageDigest?: string
  packageVersions?: string[]
  recordUri?: string
  credentialSubject?: string
  receiptSha256?: string
}

interface SourceManifest {
  reference: {
    repository: string
    revision: string
    releaseAnchor: string
    prompts: Record<string, { sha256: string }>
  }
  proposal: {
    repository: string
    revision: string
    readmePath: string
    readmeSha256: string | null
    readmeSha256Reason?: string
  }
  packages: Array<{
    name: string
    version: string
    integrity: string
    tarballSha256: string
    selection: string
  }>
  targetUriFormat: string
  referenceSupportsTargetUri: boolean
  cutoverEvidence: { status: string; uriProbe: UriProbe | null }
  legacyUriOnly: { revisions: string[]; packageVersions: string[] }
}

function loadManifest(): SourceManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as SourceManifest
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

function shapeProblems(manifest: SourceManifest): string[] {
  const problems: string[] = []
  const { reference, proposal } = manifest
  if (!nonEmpty(reference?.repository)) problems.push('reference.repository')
  if (!HEX_40.test(reference?.revision ?? ''))
    problems.push('reference.revision')
  if (!HEX_40.test(reference?.releaseAnchor ?? ''))
    problems.push('reference.releaseAnchor')
  for (const file of PROMPT_FILES) {
    if (!HEX_64.test(reference?.prompts?.[file]?.sha256 ?? ''))
      problems.push(`reference.prompts.${file}.sha256`)
  }
  if (!nonEmpty(proposal?.repository)) problems.push('proposal.repository')
  if (!HEX_40.test(proposal?.revision ?? '')) problems.push('proposal.revision')
  if (!nonEmpty(proposal?.readmePath)) problems.push('proposal.readmePath')
  if (proposal?.readmeSha256 === null) {
    if (!nonEmpty(proposal.readmeSha256Reason))
      problems.push('proposal.readmeSha256Reason')
  } else if (!HEX_64.test(proposal?.readmeSha256 ?? '')) {
    problems.push('proposal.readmeSha256')
  }
  const names = (manifest.packages ?? []).map((entry) => entry.name)
  for (const name of PACKAGE_NAMES) {
    if (names.filter((candidate) => candidate === name).length !== 1)
      problems.push(`packages: ${name} must appear exactly once`)
  }
  for (const entry of manifest.packages ?? []) {
    if (!EXACT_VERSION.test(entry.version ?? ''))
      problems.push(`${entry.name}.version`)
    if (!SHA512_INTEGRITY.test(entry.integrity ?? ''))
      problems.push(`${entry.name}.integrity`)
    if (!HEX_64.test(entry.tarballSha256 ?? ''))
      problems.push(`${entry.name}.tarballSha256`)
    if (!SELECTIONS.includes(entry.selection))
      problems.push(`${entry.name}.selection`)
  }
  return problems
}

function probeProblems(
  probe: UriProbe | null,
  manifest: SourceManifest,
): string[] {
  if (probe === null || typeof probe !== 'object')
    return ['uriProbe must be an object']
  const problems: string[] = []
  if (!HEX_40.test(probe.artifactRevision ?? ''))
    problems.push('uriProbe.artifactRevision')
  else if (probe.artifactRevision !== manifest.reference.revision)
    problems.push('uriProbe.artifactRevision must equal reference.revision')
  if (
    probe.imageDigest !== undefined &&
    !/^sha256:[0-9a-f]{64}$/.test(probe.imageDigest)
  )
    problems.push('uriProbe.imageDigest')
  const versions = probe.packageVersions
  if (
    !Array.isArray(versions) ||
    versions.length === 0 ||
    !versions.every((version) => EXACT_VERSION.test(version))
  )
    problems.push('uriProbe.packageVersions')
  else if (!sameVersions(versions, manifestVersions(manifest)))
    problems.push(
      'uriProbe.packageVersions must equal the manifest package versions',
    )
  for (const named of [probe.artifactRevision, ...(versions ?? [])]) {
    if (
      typeof named === 'string' &&
      (LEGACY_REVISIONS.includes(named) ||
        LEGACY_PACKAGE_VERSIONS.includes(named))
    )
      problems.push(`uriProbe names a legacy-only artifact: ${named}`)
  }
  if (!(probe.recordUri ?? '').startsWith(TARGET_URI_FORMAT))
    problems.push('uriProbe.recordUri must start with at:space/')
  if (!nonEmpty(probe.credentialSubject))
    problems.push('uriProbe.credentialSubject')
  if (!HEX_64.test(probe.receiptSha256 ?? ''))
    problems.push('uriProbe.receiptSha256')
  return problems
}

function manifestVersions(manifest: SourceManifest): string[] {
  return manifest.packages.map((entry) => entry.version)
}

function sameVersions(left: string[], right: string[]): boolean {
  const distinct = (versions: string[]) => [...new Set(versions)].sort()
  return JSON.stringify(distinct(left)) === JSON.stringify(distinct(right))
}

function legacyArtifactsInUse(manifest: SourceManifest): string[] {
  const used: string[] = []
  if (
    LEGACY_REVISIONS.includes(manifest.reference.revision) ||
    LEGACY_REVISIONS.includes(manifest.reference.releaseAnchor)
  )
    used.push(`reference ${manifest.reference.revision}`)
  for (const entry of manifest.packages) {
    if (LEGACY_PACKAGE_VERSIONS.includes(entry.version))
      used.push(`${entry.name}@${entry.version}`)
  }
  return used
}

// Evidence about a different artifact is not evidence about this one, so the
// probe's revision and package versions must equal the manifest's, and neither
// the manifest nor the probe may name a legacy-only artifact.
function readinessProblems(manifest: SourceManifest): string[] {
  const { referenceSupportsTargetUri, cutoverEvidence } = manifest
  if (referenceSupportsTargetUri === false) {
    const problems: string[] = []
    if (cutoverEvidence.status !== 'unfulfilled')
      problems.push('false requires cutoverEvidence.status unfulfilled')
    if (cutoverEvidence.uriProbe !== null)
      problems.push('false requires a null uriProbe')
    return problems
  }
  if (referenceSupportsTargetUri !== true)
    return ['referenceSupportsTargetUri must be a boolean']
  const problems = legacyArtifactsInUse(manifest).map(
    (artifact) => `legacy-only artifact cannot be URI-ready: ${artifact}`,
  )
  if (cutoverEvidence.status !== 'fulfilled')
    problems.push('true requires cutoverEvidence.status fulfilled')
  problems.push(...probeProblems(cutoverEvidence.uriProbe, manifest))
  return problems
}

interface LedgerPromptFields {
  promptSection: string
  decision: string
  evidence: string
}

function loadLedgerRows(): LedgerPromptFields[] {
  const parsed = JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) as {
    rows: LedgerPromptFields[]
  }
  return parsed.rows
}

// Prerequisite rows cite a prompt by release date and other rows may cite one
// by file name; the migration prompt itself is cited by every numbered section.
function promptsNamedIn(rows: LedgerPromptFields[]): string[] {
  const named = new Set<string>([MIGRATION_PROMPT])
  for (const row of rows) {
    const date = /^prerequisite:\d{4}-(\d{2})-(\d{2})$/.exec(row.promptSection)
    if (date) named.add(`prompt-${Number(date[1])}-${Number(date[2])}-26.md`)
    for (const text of [row.decision, row.evidence]) {
      for (const file of text.match(/prompt-\d+-\d+-26\.md/g) ?? [])
        named.add(file)
    }
  }
  return [...named].sort()
}

function unpinnedPrompts(
  rows: LedgerPromptFields[],
  manifest: SourceManifest,
): string[] {
  return promptsNamedIn(rows).filter(
    (file) => !HEX_64.test(manifest.reference.prompts[file]?.sha256 ?? ''),
  )
}

function withChanges(
  mutate: (manifest: SourceManifest) => void,
): SourceManifest {
  const copy = structuredClone(loadManifest())
  mutate(copy)
  return copy
}

const COMPLETE_PROBE: UriProbe = {
  artifactRevision: '0123456789abcdef0123456789abcdef01234567',
  packageVersions: ['1.2.3'],
  recordUri:
    'at:space/did:web:bebop.example/zone.stratos.space.feed/crew/did:plc:faye/zone.stratos.feed.post/swordfish',
  credentialSubject:
    'at:space/did:web:bebop.example/zone.stratos.space.feed/crew',
  receiptSha256: 'a'.repeat(64),
}

function readyManifestOnNewArtifact(): SourceManifest {
  return withChanges((manifest) => {
    manifest.reference.revision = '0123456789abcdef0123456789abcdef01234567'
    manifest.reference.releaseAnchor =
      '89abcdef0123456789abcdef0123456789abcdef'
    for (const entry of manifest.packages) entry.version = '1.2.3'
    manifest.referenceSupportsTargetUri = true
    manifest.cutoverEvidence = {
      status: 'fulfilled',
      uriProbe: structuredClone(COMPLETE_PROBE),
    }
  })
}

describe('november source manifest', () => {
  const manifest = loadManifest()

  it('has well-formed revisions, hashes, integrities and exact versions', () => {
    expect(shapeProblems(manifest)).toEqual([])
  })

  it('targets exactly the at:space/ form', () => {
    expect(manifest.targetUriFormat).toBe(TARGET_URI_FORMAT)
  })

  it('pins the migration prompt and every earlier prompt the ledger names', () => {
    expect(Object.keys(manifest.reference.prompts).sort()).toEqual(
      [...PROMPT_FILES].sort(),
    )
  })

  it('pins every prompt the applicability ledger names', () => {
    const rows = loadLedgerRows()
    expect(unpinnedPrompts(rows, manifest)).toEqual([])
    expect(promptsNamedIn(rows)).toContain('prompt-10-29-26.md')
  })

  it('keeps every legacy-only artifact on its own list', () => {
    for (const revision of LEGACY_REVISIONS)
      expect(manifest.legacyUriOnly.revisions).toContain(revision)
    for (const version of LEGACY_PACKAGE_VERSIONS)
      expect(manifest.legacyUriOnly.packageVersions).toContain(version)
  })

  it('does not claim the reference serializes the target uri without proof', () => {
    expect(readinessProblems(manifest)).toEqual([])
  })

  it('records the reference as legacy-only with unfulfilled cutover evidence', () => {
    expect(manifest.referenceSupportsTargetUri).toBe(false)
    expect(manifest.cutoverEvidence).toEqual({
      status: 'unfulfilled',
      uriProbe: null,
    })
    expect(legacyArtifactsInUse(manifest).length).toBeGreaterThan(0)
  })
})

describe('november uri readiness rule', () => {
  it('rejects true with no evidence', () => {
    const claimed = withChanges((m) => {
      m.referenceSupportsTargetUri = true
    })
    expect(readinessProblems(claimed)).not.toEqual([])
  })

  it('rejects true for a legacy-only artifact whatever the probe says', () => {
    const claimed = withChanges((m) => {
      m.referenceSupportsTargetUri = true
      m.cutoverEvidence = {
        status: 'fulfilled',
        uriProbe: structuredClone(COMPLETE_PROBE),
      }
    })
    const problems = readinessProblems(claimed)
    expect(problems.some((p) => p.startsWith('legacy-only artifact'))).toBe(
      true,
    )
  })

  it.each(LEGACY_PACKAGE_VERSIONS)(
    'rejects true when a package is at legacy version %s',
    (version) => {
      const claimed = readyManifestOnNewArtifact()
      claimed.packages[0]!.version = version
      expect(readinessProblems(claimed)).not.toEqual([])
    },
  )

  it.each(LEGACY_REVISIONS)(
    'rejects true when the reference is at legacy revision %s',
    (revision) => {
      const claimed = readyManifestOnNewArtifact()
      claimed.reference.revision = revision
      expect(readinessProblems(claimed)).not.toEqual([])
    },
  )

  it('accepts true on a different artifact with a complete probe', () => {
    expect(readinessProblems(readyManifestOnNewArtifact())).toEqual([])
  })

  it('rejects true on a different artifact with a partial probe', () => {
    const fields: Array<keyof UriProbe> = [
      'recordUri',
      'credentialSubject',
      'receiptSha256',
      'packageVersions',
    ]
    for (const field of fields) {
      const claimed = readyManifestOnNewArtifact()
      delete claimed.cutoverEvidence.uriProbe![field]
      expect(readinessProblems(claimed), field).not.toEqual([])
    }
    const noArtifact = readyManifestOnNewArtifact()
    delete noArtifact.cutoverEvidence.uriProbe!.artifactRevision
    expect(readinessProblems(noArtifact)).not.toEqual([])
  })

  it('rejects a probe that ran against a different revision than the manifest', () => {
    const claimed = readyManifestOnNewArtifact()
    claimed.cutoverEvidence.uriProbe!.artifactRevision =
      'fedcba9876543210fedcba9876543210fedcba98'
    expect(readinessProblems(claimed)).toContain(
      'uriProbe.artifactRevision must equal reference.revision',
    )
  })

  it('rejects a probe whose package versions differ from the manifest', () => {
    const otherVersion = readyManifestOnNewArtifact()
    otherVersion.cutoverEvidence.uriProbe!.packageVersions = ['1.2.4']
    expect(readinessProblems(otherVersion)).toContain(
      'uriProbe.packageVersions must equal the manifest package versions',
    )
    const extraVersion = readyManifestOnNewArtifact()
    extraVersion.cutoverEvidence.uriProbe!.packageVersions = ['1.2.3', '1.2.4']
    expect(readinessProblems(extraVersion)).toContain(
      'uriProbe.packageVersions must equal the manifest package versions',
    )
  })

  it.each(LEGACY_REVISIONS)(
    'rejects a probe naming the legacy-only revision %s',
    (revision) => {
      const claimed = readyManifestOnNewArtifact()
      claimed.cutoverEvidence.uriProbe!.artifactRevision = revision
      expect(readinessProblems(claimed)).toContain(
        `uriProbe names a legacy-only artifact: ${revision}`,
      )
    },
  )

  it.each(LEGACY_PACKAGE_VERSIONS)(
    'rejects a probe naming the legacy-only package version %s',
    (version) => {
      const claimed = readyManifestOnNewArtifact()
      claimed.cutoverEvidence.uriProbe!.packageVersions = ['1.2.3', version]
      expect(readinessProblems(claimed)).toContain(
        `uriProbe names a legacy-only artifact: ${version}`,
      )
    },
  )

  it('rejects a probe whose record uri is in the legacy form', () => {
    const claimed = readyManifestOnNewArtifact()
    claimed.cutoverEvidence.uriProbe!.recordUri =
      'at://did:web:bebop.example/space/zone.stratos.space.feed/crew/did:plc:faye/zone.stratos.feed.post/swordfish'
    expect(readinessProblems(claimed)).not.toEqual([])
  })

  it('rejects true while the evidence is unfulfilled', () => {
    const claimed = readyManifestOnNewArtifact()
    claimed.cutoverEvidence.status = 'unfulfilled'
    expect(readinessProblems(claimed)).not.toEqual([])
  })

  it('rejects false with fulfilled evidence', () => {
    const contradictory = withChanges((m) => {
      m.cutoverEvidence = {
        status: 'fulfilled',
        uriProbe: structuredClone(COMPLETE_PROBE),
      }
    })
    expect(readinessProblems(contradictory)).not.toEqual([])
  })
})

describe('november prompt pin rule', () => {
  const pinned = loadManifest()

  it('reports a prompt the ledger names but the manifest does not pin', () => {
    const rows = [
      { promptSection: 'prerequisite:2026-10-01', evidence: '', decision: '' },
    ]
    expect(unpinnedPrompts(rows, pinned)).toEqual(['prompt-10-1-26.md'])
  })

  it('reads a prompt file named in evidence text', () => {
    const rows = [
      {
        promptSection: 'base',
        decision: '',
        evidence: 'see prompt-9-3-26.md section 2',
      },
    ]
    expect(unpinnedPrompts(rows, pinned)).toEqual(['prompt-9-3-26.md'])
  })

  it('always requires the migration prompt', () => {
    const withoutMigration = withChanges((m) => {
      delete m.reference.prompts[MIGRATION_PROMPT]
    })
    expect(unpinnedPrompts([], withoutMigration)).toEqual([MIGRATION_PROMPT])
  })
})

describe('november manifest shape guard', () => {
  it('rejects a version range', () => {
    const ranged = withChanges((m) => {
      m.packages[0]!.version = '^0.0.0-spaces-alpha-20261117141222'
    })
    expect(shapeProblems(ranged)).toContain('@atproto/api.version')
  })

  it('rejects a prompt hash with a non-hex character or the wrong length', () => {
    const nonHex = withChanges((m) => {
      const entry = m.reference.prompts['prompt-11-12-26.md']!
      entry.sha256 = `g${entry.sha256.slice(1)}`
    })
    expect(shapeProblems(nonHex)).toContain(
      'reference.prompts.prompt-11-12-26.md.sha256',
    )
    const short = withChanges((m) => {
      const entry = m.reference.prompts['prompt-11-12-26.md']!
      entry.sha256 = entry.sha256.slice(1)
    })
    expect(shapeProblems(short)).toContain(
      'reference.prompts.prompt-11-12-26.md.sha256',
    )
  })

  it('rejects a short revision and an empty field', () => {
    const shortRevision = withChanges((m) => {
      m.reference.revision = m.reference.revision.slice(1)
    })
    expect(shapeProblems(shortRevision)).toContain('reference.revision')
    const empty = withChanges((m) => {
      m.reference.repository = ''
    })
    expect(shapeProblems(empty)).toContain('reference.repository')
  })

  it('rejects a package integrity that is not sha512', () => {
    const weak = withChanges((m) => {
      m.packages[1]!.integrity = 'sha1-abc'
    })
    expect(shapeProblems(weak)).toContain('@atproto/syntax.integrity')
  })

  it('requires a reason when the proposal hash is null', () => {
    const unexplained = withChanges((m) => {
      m.proposal.readmeSha256 = null
      delete m.proposal.readmeSha256Reason
    })
    expect(shapeProblems(unexplained)).toContain('proposal.readmeSha256Reason')
  })
})
