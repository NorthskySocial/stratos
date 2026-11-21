import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PdsSourcePin } from '../build-alpha-pds.js'

const SOURCES_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'sources.json',
)

const OCTOBER_SOURCES_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../sources.json',
)

const TARGET_URI_FORMAT = 'at:space/'
const HEX_40 = /^[0-9a-f]{40}$/
const HEX_64 = /^[0-9a-f]{64}$/
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/

// Held here as well as in the manifest so that editing the manifest cannot
// shrink the list of artifacts that only serialize the earlier spelling.
const LEGACY_REVISIONS = [
  'b5fd12fa57b10cf068efa879812f558780f37109',
  'd4def6e9f521896ed8222f576d54923d00b5fbeb',
]
const LEGACY_PACKAGE_VERSIONS = [
  '0.0.0-spaces-alpha-20261117141222',
  '0.0.0-spaces-alpha-20261112204144',
]

export interface UriProbe {
  artifactRevision?: string
  imageDigest?: string
  packageVersions?: string[]
  recordUri?: string
  credentialSubject?: string
  receiptSha256?: string
}

export interface NovemberSources {
  reference: { revision: string; releaseAnchor: string }
  packages: Array<{ name: string; version: string }>
  referenceSupportsTargetUri: boolean
  cutoverEvidence: { status: string; uriProbe: UriProbe | null }
  legacyUriOnly: { revisions: string[]; packageVersions: string[] }
  referenceHost: {
    url: string
    dockerfile: string
    lockfile: string
    sha256: Record<string, string>
  }
}

export function loadNovemberSources(): NovemberSources {
  return JSON.parse(readFileSync(SOURCES_PATH, 'utf8')) as NovemberSources
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

// The October file pins the source the earlier reference host was built from;
// that build serializes the earlier spelling too.
function octoberPdsRevision(): string[] {
  const pinned = (
    JSON.parse(readFileSync(OCTOBER_SOURCES_PATH, 'utf8')) as {
      octoberSpacesPds?: { revision?: string }
    }
  ).octoberSpacesPds?.revision
  return pinned ? [pinned] : []
}

function legacyRevisions(sources: NovemberSources): string[] {
  return [
    ...new Set([
      ...LEGACY_REVISIONS,
      ...sources.legacyUriOnly.revisions,
      ...octoberPdsRevision(),
    ]),
  ]
}

function legacyVersions(sources: NovemberSources): string[] {
  return [
    ...new Set([
      ...LEGACY_PACKAGE_VERSIONS,
      ...sources.legacyUriOnly.packageVersions,
    ]),
  ]
}

function probeProblems(
  probe: UriProbe | null,
  sources: NovemberSources,
): string[] {
  if (probe === null || typeof probe !== 'object')
    return ['uriProbe must be an object']
  const problems: string[] = []
  if (!HEX_40.test(probe.artifactRevision ?? ''))
    problems.push('uriProbe.artifactRevision')
  else if (probe.artifactRevision !== sources.reference.revision)
    problems.push('uriProbe.artifactRevision must equal reference.revision')
  if (probe.imageDigest !== undefined && !IMAGE_DIGEST.test(probe.imageDigest))
    problems.push('uriProbe.imageDigest')
  const versions = probe.packageVersions
  const manifestVersions = [
    ...new Set(sources.packages.map((entry) => entry.version)),
  ].sort()
  if (!Array.isArray(versions) || versions.length === 0)
    problems.push('uriProbe.packageVersions')
  else if (
    JSON.stringify([...new Set(versions)].sort()) !==
    JSON.stringify(manifestVersions)
  )
    problems.push(
      'uriProbe.packageVersions must equal the manifest package versions',
    )
  if (!(probe.recordUri ?? '').startsWith(TARGET_URI_FORMAT))
    problems.push('uriProbe.recordUri must start with at:space/')
  if (!nonEmpty(probe.credentialSubject))
    problems.push('uriProbe.credentialSubject')
  if (!HEX_64.test(probe.receiptSha256 ?? ''))
    problems.push('uriProbe.receiptSha256')
  return problems
}

/**
 * Why the manifest does not yet say a reference host accepts the new
 * spelling. An empty list means the cutover evidence is complete and names no
 * artifact that only serializes the earlier spelling.
 */
export function manifestReadinessProblems(sources: NovemberSources): string[] {
  if (sources.referenceSupportsTargetUri !== true)
    return ['the reference host is not recorded as accepting at:space/']
  const problems: string[] = []
  const badRevisions = legacyRevisions(sources)
  const badVersions = legacyVersions(sources)
  for (const revision of [
    sources.reference.revision,
    sources.reference.releaseAnchor,
  ]) {
    if (badRevisions.includes(revision))
      problems.push(`legacy-only revision cannot be URI-ready: ${revision}`)
  }
  for (const entry of sources.packages) {
    if (badVersions.includes(entry.version))
      problems.push(
        `legacy-only package cannot be URI-ready: ${entry.name}@${entry.version}`,
      )
  }
  if (sources.cutoverEvidence.status !== 'fulfilled')
    problems.push('cutoverEvidence.status is not fulfilled')
  problems.push(...probeProblems(sources.cutoverEvidence.uriProbe, sources))
  return problems
}

/**
 * Why the reference host cannot be built from this manifest: the cutover
 * evidence is incomplete, or the repository file hashes are not filled in.
 */
export function referenceHostBuildProblems(sources: NovemberSources): string[] {
  const problems = manifestReadinessProblems(sources)
  const { url, dockerfile, lockfile, sha256 } = sources.referenceHost
  if (!nonEmpty(url)) problems.push('referenceHost.url is empty')
  for (const path of [dockerfile, lockfile]) {
    if (!HEX_64.test(sha256?.[path] ?? ''))
      problems.push(`referenceHost.sha256 has no hash for ${path}`)
  }
  return problems
}

/** The pin the runner builds the reference host from; refuses while empty. */
export function referenceHostPin(sources: NovemberSources): PdsSourcePin {
  const problems = referenceHostBuildProblems(sources)
  if (problems.length > 0)
    throw new Error(`Reference PDS is not buildable: ${problems.join('; ')}`)
  const { url, dockerfile, lockfile, sha256 } = sources.referenceHost
  return {
    url,
    revision: sources.reference.revision,
    dockerfile,
    lockfile,
    sha256,
  }
}

export function assertImageDigest(value: string | undefined): string {
  if (value === undefined || !IMAGE_DIGEST.test(value))
    throw new Error('--pds-image-digest must name a sha256:<64 hex> digest')
  return value
}
