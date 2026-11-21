import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadNovemberSources } from './november/reference-host.js'
import type { NovemberSources } from './november/reference-host.js'
import {
  parseOptions,
  PREPARED_SUITE_IDS,
  requirePreparedRunConditions,
} from './run-sandbox.js'
import { STANDALONE_SUITE_IDS, suiteExecutionOrder } from './rules.js'
import { suite as baseline } from './scenarios/baseline.js'
import { suite as novemberInterop } from './scenarios/november-interop.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIGEST = `sha256:${'c'.repeat(64)}`
const REVISION = '0123456789abcdef0123456789abcdef01234567'

function readySources(imageDigest = DIGEST): NovemberSources {
  const sources = structuredClone(loadNovemberSources())
  sources.reference.revision = REVISION
  sources.reference.releaseAnchor = '89abcdef0123456789abcdef0123456789abcdef'
  for (const entry of sources.packages) entry.version = '1.2.3'
  sources.referenceSupportsTargetUri = true
  sources.cutoverEvidence = {
    status: 'fulfilled',
    uriProbe: {
      artifactRevision: REVISION,
      imageDigest,
      packageVersions: ['1.2.3'],
      recordUri:
        'at:space/did:web:bebop.example/zone.stratos.space.feed/crew/did:plc:faye/zone.stratos.feed.post/swordfish',
      credentialSubject:
        'at:space/did:web:bebop.example/zone.stratos.space.feed/crew',
      receiptSha256: 'a'.repeat(64),
    },
  }
  return sources
}

describe('the prepared november-interop suite', () => {
  it('is prepared, refuses to run without an explicit option naming a PDS image digest', () => {
    expect(PREPARED_SUITE_IDS.has(novemberInterop.id)).toBe(true)
    expect(() =>
      requirePreparedRunConditions(
        novemberInterop.id,
        undefined,
        readySources(),
      ),
    ).toThrow('runs only with --pds-image-digest')
  })

  it('refuses a named digest while the November manifest is not ready', () => {
    expect(() =>
      requirePreparedRunConditions(
        novemberInterop.id,
        DIGEST,
        loadNovemberSources(),
      ),
    ).toThrow('the November manifest is not ready')
  })

  it('refuses a digest that is not the one the cutover probe recorded', () => {
    expect(() =>
      requirePreparedRunConditions(
        novemberInterop.id,
        `sha256:${'d'.repeat(64)}`,
        readySources(),
      ),
    ).toThrow('differs from uriProbe.imageDigest')
  })

  it('starts when the digest is named and the manifest is ready', () => {
    expect(() =>
      requirePreparedRunConditions(novemberInterop.id, DIGEST, readySources()),
    ).not.toThrow()
  })

  it('takes the digest option and refuses a malformed one', () => {
    const base = [
      '--sandbox-dir',
      '/tmp/faye-sandbox',
      '--source',
      '/tmp/faye-source',
      '--report-dir',
      '/tmp/faye-report',
      '--suite',
      'november-interop',
      '--review-receipt',
      '/tmp/faye-receipt.json',
    ]
    expect(parseOptions([...base, '--pds-image-digest', DIGEST])).toMatchObject(
      {
        suite: 'november-interop',
        pdsImageDigest: DIGEST,
      },
    )
    expect(parseOptions(base).pdsImageDigest).toBeUndefined()
    expect(() =>
      parseOptions([...base, '--pds-image-digest', 'latest']),
    ).toThrow('--pds-image-digest must name a sha256')
  })

  it('runs after the baseline like any other selected suite, never alone', () => {
    expect(STANDALONE_SUITE_IDS.has(novemberInterop.id)).toBe(false)
    expect(
      suiteExecutionOrder(novemberInterop.id, [baseline, novemberInterop]).map(
        (suite) => suite.id,
      ),
    ).toEqual(['baseline', 'november-interop'])
  })

  it('is not named by the workflow that runs on every pull request', () => {
    const workflow = readFileSync(
      resolve(HERE, '../../.github/workflows/e2e.yml'),
      'utf8',
    )
    for (const id of PREPARED_SUITE_IDS) expect(workflow).not.toContain(id)
    expect(workflow).toContain('--suite baseline')
  })
})
