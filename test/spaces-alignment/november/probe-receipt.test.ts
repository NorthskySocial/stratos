import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  loadNovemberSources,
  manifestReadinessProblems,
} from './reference-host.js'

describe('published host URI evidence', () => {
  it('accepts the recorded release and rejects changed identity or digest', () => {
    const sources = loadNovemberSources()
    expect(manifestReadinessProblems(sources)).toEqual([])
    for (const field of [
      'recordUri',
      'credentialSubject',
      'imageDigest',
      'receiptSha256',
    ] as const) {
      const changed = structuredClone(sources)
      changed.cutoverEvidence.uriProbe![field] = 'wrong'
      expect(manifestReadinessProblems(changed)).not.toEqual([])
    }
  })
  it('rejects configured identities that do not match the observed receipt', () => {
    const sources = loadNovemberSources()
    sources.cutoverEvidence.uriProbe!.expected!.rkey = 'other'
    expect(manifestReadinessProblems(sources)).not.toEqual([])
    sources.cutoverEvidence.uriProbe!.expected!.authority = 'not-a-did'
    expect(manifestReadinessProblems(sources)).toContain(
      'uriProbe.expected contains invalid identifiers',
    )
  })
  it('rejects arbitrary altered identities even when their prefix is valid', () => {
    const original = loadNovemberSources().cutoverEvidence.uriProbe!
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 80 }), (suffix) => {
        for (const field of ['recordUri', 'credentialSubject'] as const) {
          const sources = loadNovemberSources()
          sources.cutoverEvidence.uriProbe![field] = original[field]! + suffix
          expect(manifestReadinessProblems(sources)).not.toEqual([])
        }
      }),
      { numRuns: 100 },
    )
  })
})
