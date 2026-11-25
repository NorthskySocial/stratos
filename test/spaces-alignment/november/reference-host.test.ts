import { describe, expect, it } from 'vitest'
import {
  loadNovemberSources,
  manifestReadinessProblems,
  referenceHostBuildProblems,
  referenceHostPin,
} from './reference-host.js'

describe('reference host build pin', () => {
  it('uses the published release source and verified build inputs', () => {
    const sources = loadNovemberSources()
    expect(manifestReadinessProblems(sources)).toEqual([])
    expect(referenceHostPin(sources)).toMatchObject({
      revision: '1f510f8e36a973f6fd055da349b586918805ae66',
      dockerfile: 'Dockerfile',
      lockfile: 'pnpm-lock.yaml',
    })
  })
  it.each(['Dockerfile', 'pnpm-lock.yaml'])(
    'refuses a missing or malformed hash for %s',
    (path) => {
      for (const hash of ['', 'z'.repeat(64)]) {
        const sources = loadNovemberSources()
        sources.referenceHost.sha256[path] = hash
        expect(referenceHostBuildProblems(sources)).toContain(
          `referenceHost.sha256 has no hash for ${path}`,
        )
        expect(() => referenceHostPin(sources)).toThrow(path)
      }
    },
  )
  it('refuses a missing repository URL', () => {
    const sources = loadNovemberSources()
    sources.referenceHost.url = ''
    expect(referenceHostBuildProblems(sources)).toContain(
      'referenceHost.url is empty',
    )
  })
  it('refuses a legacy source revision and incomplete evidence', () => {
    const sources = loadNovemberSources()
    sources.reference.revision = 'b5fd12fa57b10cf068efa879812f558780f37109'
    expect(manifestReadinessProblems(sources).join(' ')).toContain(
      'legacy-only revision',
    )
    sources.cutoverEvidence.status = 'unfulfilled'
    expect(manifestReadinessProblems(sources)).toContain(
      'cutoverEvidence.status is not fulfilled',
    )
  })
})
