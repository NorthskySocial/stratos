import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  loadNovemberSources,
  manifestReadinessProblems,
  referenceHostBuildProblems,
  referenceHostPin,
} from './reference-host.js'
import type { NovemberSources } from './reference-host.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const READY_REVISION = '0123456789abcdef0123456789abcdef01234567'
const OCTOBER_PDS_REVISION = (
  JSON.parse(readFileSync(resolve(HERE, '../sources.json'), 'utf8')) as {
    octoberSpacesPds: { revision: string }
  }
).octoberSpacesPds.revision

function readySources(): NovemberSources {
  const sources = structuredClone(loadNovemberSources())
  sources.reference.revision = READY_REVISION
  sources.reference.releaseAnchor = '89abcdef0123456789abcdef0123456789abcdef'
  for (const entry of sources.packages) entry.version = '1.2.3'
  sources.referenceSupportsTargetUri = true
  sources.cutoverEvidence = {
    status: 'fulfilled',
    uriProbe: {
      artifactRevision: READY_REVISION,
      packageVersions: ['1.2.3'],
      recordUri:
        'at:space/did:web:bebop.example/zone.stratos.space.feed/crew/did:plc:faye/zone.stratos.feed.post/swordfish',
      credentialSubject:
        'at:space/did:web:bebop.example/zone.stratos.space.feed/crew',
      receiptSha256: 'a'.repeat(64),
    },
  }
  sources.referenceHost.sha256 = {
    Dockerfile: 'a'.repeat(64),
    'pnpm-lock.yaml': 'b'.repeat(64),
  }
  return sources
}

describe('reference host build pin', () => {
  it('is refused today: the manifest names legacy-only artifacts and no hashes', () => {
    const problems = referenceHostBuildProblems(loadNovemberSources())
    expect(problems).not.toEqual([])
    expect(() => referenceHostPin(loadNovemberSources())).toThrow(
      'Reference PDS is not buildable',
    )
  })

  it('never names the revision the October file pins', () => {
    const sources = loadNovemberSources()
    expect(sources.reference.revision).not.toBe(OCTOBER_PDS_REVISION)
    expect(sources.reference.releaseAnchor).not.toBe(OCTOBER_PDS_REVISION)
  })

  it('builds the upstream repository root Dockerfile at the manifest revision', () => {
    const pin = referenceHostPin(readySources())
    expect(pin).toEqual({
      url: 'https://github.com/bluesky-social/atproto.git',
      revision: READY_REVISION,
      dockerfile: 'Dockerfile',
      lockfile: 'pnpm-lock.yaml',
      sha256: { Dockerfile: 'a'.repeat(64), 'pnpm-lock.yaml': 'b'.repeat(64) },
    })
  })

  it('is refused while a file hash slot is empty', () => {
    for (const path of ['Dockerfile', 'pnpm-lock.yaml']) {
      const sources = readySources()
      delete sources.referenceHost.sha256[path]
      expect(referenceHostBuildProblems(sources)).toContain(
        `referenceHost.sha256 has no hash for ${path}`,
      )
      expect(() => referenceHostPin(sources)).toThrow(path)
    }
  })

  it.each(['b5fd12fa57b10cf068efa879812f558780f37109', OCTOBER_PDS_REVISION])(
    'is refused for the earlier-spelling revision %s',
    (revision) => {
      const sources = readySources()
      sources.reference.revision = revision
      sources.cutoverEvidence.uriProbe!.artifactRevision = revision
      expect(() => referenceHostPin(sources)).toThrow('legacy-only revision')
    },
  )

  it('is refused for a legacy-only package version', () => {
    const sources = readySources()
    sources.packages[0]!.version = '0.0.0-spaces-alpha-20261117141222'
    sources.cutoverEvidence.uriProbe!.packageVersions = [
      sources.packages[0]!.version,
      '1.2.3',
    ]
    expect(manifestReadinessProblems(sources).join('\n')).toContain(
      'legacy-only package',
    )
  })

  it('is refused while the cutover evidence is unfulfilled or the probe is partial', () => {
    const unfulfilled = readySources()
    unfulfilled.cutoverEvidence.status = 'unfulfilled'
    expect(manifestReadinessProblems(unfulfilled)).toContain(
      'cutoverEvidence.status is not fulfilled',
    )
    const partial = readySources()
    delete partial.cutoverEvidence.uriProbe!.receiptSha256
    expect(manifestReadinessProblems(partial)).toContain(
      'uriProbe.receiptSha256',
    )
    const earlierUri = readySources()
    earlierUri.cutoverEvidence.uriProbe!.recordUri = 'at://did:plc:faye/x/y'
    expect(manifestReadinessProblems(earlierUri)).toContain(
      'uriProbe.recordUri must start with at:space/',
    )
  })
})
