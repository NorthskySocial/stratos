import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PdsSourcePin } from '../build-alpha-pds.js'
import {
  parseSpaceUri,
  parseSpaceRecordUri,
} from '../../../stratos-client/src/space-uri.js'

const SOURCES_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'sources.json',
)

const OCTOBER_SOURCES_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../sources.json',
)

const HEX_40 = /^[0-9a-f]{40}$/
const HEX_64 = /^[0-9a-f]{64}$/
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/
// Held here as well as in the manifest so that editing the manifest cannot
// shrink the list of artifacts that only serialize the earlier spelling.
const LEGACY_REVISIONS = [
  'b5fd12fa57b10cf068efa879812f558780f37109',
  'd4def6e9f521896ed8222f576d54923d00b5fbeb',
]

export interface UriProbe {
  artifactRevision?: string
  imageDigest?: string
  expected?: {
    authority: string
    spaceType: string
    spaceKey: string
    author: string
    collection: string
    rkey: string
  }
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

function probeProblems(
  probe: UriProbe | null,
  sources: NovemberSources,
): string[] {
  if (!probe || typeof probe !== 'object') return ['uriProbe must be an object']
  const problems: string[] = []
  if (
    !HEX_40.test(probe.artifactRevision ?? '') ||
    probe.artifactRevision !== sources.reference.revision
  )
    problems.push('uriProbe.artifactRevision must equal reference.revision')
  if (!IMAGE_DIGEST.test(probe.imageDigest ?? ''))
    problems.push('uriProbe.imageDigest')
  if (!HEX_64.test(probe.receiptSha256 ?? ''))
    problems.push('uriProbe.receiptSha256')
  try {
    const bytes = readFileSync(
      resolve(dirname(SOURCES_PATH), 'uri-probe-receipt.json'),
    )
    if (
      createHash('sha256').update(bytes).digest('hex') !== probe.receiptSha256
    )
      problems.push('uriProbe.receiptSha256 does not match receipt')
    const receipt = JSON.parse(bytes.toString()) as {
      publishedPdsDigest: string
      dottedAuthority: Array<{
        test: string
        uri?: string
        cid?: string
        space?: string
      }>
    }
    if (receipt.publishedPdsDigest !== probe.imageDigest)
      problems.push('uriProbe.imageDigest does not match receipt')
    const create = receipt.dottedAuthority.find(
      (row) => row.test === 'OAuth create and read returned exact URI and CID',
    )
    const credential = receipt.dottedAuthority.find(
      (row) =>
        row.test === 'Stratos minted bound credential for exact dotted space',
    )
    const read = receipt.dottedAuthority.find(
      (row) =>
        row.test ===
        'Published PDS accepted Stratos credential and returned a verified record MAC',
    )
    const expected = probe.expected
    if (!expected || !Object.values(expected).every(nonEmpty)) {
      problems.push('uriProbe.expected')
      return problems
    }
    const expectedSubject = `at:space/${expected.authority}/${expected.spaceType}/${expected.spaceKey}`
    const expectedUri = `${expectedSubject}/${expected.author}/${expected.collection}/${expected.rkey}`
    if (
      !parseSpaceUri(expectedSubject).ok ||
      !parseSpaceRecordUri(expectedUri).ok
    )
      problems.push('uriProbe.expected contains invalid identifiers')
    if (
      probe.credentialSubject !== expectedSubject ||
      credential?.space !== expectedSubject
    )
      problems.push(
        'uriProbe.credentialSubject must match the configured space and receipt',
      )
    if (
      probe.recordUri !== expectedUri ||
      create?.uri !== expectedUri ||
      read?.uri !== expectedUri ||
      !create.cid ||
      create.cid !== read?.cid
    )
      problems.push(
        'uriProbe.recordUri must match the configured record and create/read receipt',
      )
  } catch {
    problems.push('uriProbe receipt is missing or invalid')
  }
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
  for (const revision of [
    sources.reference.revision,
    sources.reference.releaseAnchor,
  ]) {
    if (badRevisions.includes(revision))
      problems.push(`legacy-only revision cannot be URI-ready: ${revision}`)
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
