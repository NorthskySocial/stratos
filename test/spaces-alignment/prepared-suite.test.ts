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
const DIGEST =
  'sha256:7edcfdfe1c6e2638de00b1d718d8702bce321389595711aab9f8008b3e269350'

function readySources(): NovemberSources {
  return structuredClone(loadNovemberSources())
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
      requirePreparedRunConditions(novemberInterop.id, DIGEST, {
        ...loadNovemberSources(),
        referenceSupportsTargetUri: false,
      }),
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
