import { describe, expect, it } from 'vitest'
import {
  suiteExecutionOrder,
  validateAssertions,
  validateReviewReceipt,
} from './rules.js'
import type { ScenarioSuite } from './rules.js'

const sha = 'a'.repeat(40)
const base = 'b'.repeat(40)
const review = (sessionId: string, model = 'gpt-5.6-terra') => ({
  model,
  verdict: 'approved',
  reviewedSha: sha,
  sessionId,
  evidenceRef: `private:${sessionId}`,
  unresolvedBlockingFindings: 0,
})
const receipt = () => ({
  candidateSha: sha,
  baseSha: base,
  reviews: { standards: review('standards-1'), spec: review('spec-1') },
})
const suite = (id: string, requiredAssertions = ['passes']): ScenarioSuite => ({
  id,
  requiredAssertions,
  async run() {
    return []
  },
})

describe('review receipt gate', () => {
  it('requires separate approved-model reviews for the exact candidate and parent', () => {
    expect(validateReviewReceipt(receipt(), sha, base).candidateSha).toBe(sha)
    expect(() => validateReviewReceipt(receipt(), base, sha)).toThrow(
      'Review receipt does not match',
    )
    const solReviews = {
      candidateSha: sha,
      baseSha: base,
      reviews: {
        standards: review('standards-sol', 'gpt-6.1-sol'),
        spec: review('spec-sol', 'gpt-6.1-sol'),
      },
    }
    expect(validateReviewReceipt(solReviews, sha, base).candidateSha).toBe(sha)
    const wrongModel = receipt()
    wrongModel.reviews.spec.model = 'gpt-6-sol'
    expect(() => validateReviewReceipt(wrongModel, sha, base)).toThrow(
      'spec review does not approve this candidate with an accepted model',
    )
    const invalidModelType = receipt()
    invalidModelType.reviews.spec.model = 5 as never
    expect(() => validateReviewReceipt(invalidModelType, sha, base)).toThrow(
      'spec review model must be a string',
    )
    const blocked = receipt()
    blocked.reviews.spec.unresolvedBlockingFindings = 1
    expect(() => validateReviewReceipt(blocked, sha, base)).toThrow(
      'spec review has missing evidence',
    )
    const sameSession = receipt()
    sameSession.reviews.spec.sessionId = 'standards-1'
    expect(() => validateReviewReceipt(sameSession, sha, base)).toThrow(
      'separate review sessions',
    )
  })

  it('rejects malformed receipts at each boundary', () => {
    expect(() => validateReviewReceipt(null, sha, base)).toThrow(
      'Expected a JSON object',
    )
    expect(() => validateReviewReceipt([], sha, base)).toThrow(
      'Expected a JSON object',
    )
    expect(() => validateReviewReceipt('not an object', sha, base)).toThrow(
      'Expected a JSON object',
    )
    expect(() => validateReviewReceipt(receipt(), sha, sha)).toThrow(
      'distinct full Git SHAs',
    )
    expect(() => validateReviewReceipt(receipt(), 'short', base)).toThrow(
      'distinct full Git SHAs',
    )
    expect(() => validateReviewReceipt(receipt(), `x${sha}`, base)).toThrow(
      'distinct full Git SHAs',
    )
    expect(() => validateReviewReceipt(receipt(), `${sha}x`, base)).toThrow(
      'distinct full Git SHAs',
    )
    expect(() => validateReviewReceipt(receipt(), sha, 'short')).toThrow(
      'distinct full Git SHAs',
    )
    expect(() =>
      validateReviewReceipt({ ...receipt(), candidateSha: base }, sha, base),
    ).toThrow('Review receipt does not match')
    expect(() =>
      validateReviewReceipt({ ...receipt(), baseSha: sha }, sha, base),
    ).toThrow('Review receipt does not match')
    expect(() =>
      validateReviewReceipt({ ...receipt(), reviews: null }, sha, base),
    ).toThrow('Expected a JSON object')
    const wrongVerdict = receipt()
    wrongVerdict.reviews.standards.verdict = 'changes-requested'
    expect(() => validateReviewReceipt(wrongVerdict, sha, base)).toThrow(
      'standards review does not approve this candidate with an accepted model',
    )
    const wrongReviewedSha = receipt()
    wrongReviewedSha.reviews.spec.reviewedSha = base
    expect(() => validateReviewReceipt(wrongReviewedSha, sha, base)).toThrow(
      'spec review does not approve this candidate with an accepted model',
    )
    const missingSession = receipt()
    missingSession.reviews.spec.sessionId = ''
    expect(() => validateReviewReceipt(missingSession, sha, base)).toThrow(
      'spec review has missing evidence',
    )
    const missingEvidence = receipt()
    missingEvidence.reviews.spec.evidenceRef = ''
    expect(() => validateReviewReceipt(missingEvidence, sha, base)).toThrow(
      'spec review has missing evidence',
    )
    const invalidSession = receipt()
    invalidSession.reviews.spec.sessionId = 5 as never
    expect(() => validateReviewReceipt(invalidSession, sha, base)).toThrow(
      'spec review has missing evidence',
    )
    const invalidEvidence = receipt()
    invalidEvidence.reviews.spec.evidenceRef = 5 as never
    expect(() => validateReviewReceipt(invalidEvidence, sha, base)).toThrow(
      'spec review has missing evidence',
    )
  })
})

describe('suite gate', () => {
  it('runs baseline before a selected extension', () => {
    expect(
      suiteExecutionOrder('extra', [suite('extra'), suite('baseline')]).map(
        (item) => item.id,
      ),
    ).toEqual(['baseline', 'extra'])
    expect(() => suiteExecutionOrder('missing', [suite('baseline')])).toThrow(
      'Unknown or unavailable suite',
    )
    expect(() =>
      suiteExecutionOrder('baseline', [suite('baseline'), suite('baseline')]),
    ).toThrow('Duplicate suite')
    expect(() => suiteExecutionOrder('baseline', [suite('other')])).toThrow(
      'Unknown or unavailable suite',
    )
    expect(() =>
      suiteExecutionOrder('baseline', [suite('bad/id'), suite('baseline')]),
    ).toThrow('Invalid suite declaration')
    expect(() =>
      suiteExecutionOrder('baseline', [suite('baseline', [])]),
    ).toThrow('Invalid suite declaration')
    expect(() =>
      suiteExecutionOrder('baseline', [
        suite('baseline', ['passes', 'passes']),
      ]),
    ).toThrow('Invalid suite declaration')
    expect(() =>
      suiteExecutionOrder('baseline', [suite('baseline', ['bad/id'])]),
    ).toThrow('Invalid suite declaration')
    expect(() =>
      suiteExecutionOrder('baseline', [
        suite('baseline', ['passes', 'bad/id']),
      ]),
    ).toThrow('Invalid suite declaration')
    expect(() =>
      suiteExecutionOrder('baseline', [
        { ...suite('baseline'), run: undefined as never },
      ]),
    ).toThrow('has no runner')
  })

  it('rejects zero, skipped, failed, duplicate and missing assertions', () => {
    const baseline = suite('baseline', ['passes', 'also-passes'])
    expect(() => validateAssertions(baseline, [])).toThrow(
      'returned zero assertions',
    )
    expect(() =>
      validateAssertions(baseline, [{ id: 'passes', status: 'passed' }]),
    ).toThrow('omitted required assertion')
    expect(() =>
      validateAssertions(baseline, [{ id: 'passes', status: 'skipped' }]),
    ).toThrow('is skipped')
    expect(() =>
      validateAssertions(baseline, [{ id: 'passes', status: 'failed' }]),
    ).toThrow('is failed')
    expect(() =>
      validateAssertions(baseline, [
        { id: 'passes', status: 'passed' },
        { id: 'passes', status: 'passed' },
      ]),
    ).toThrow('duplicate assertion')
    expect(() =>
      validateAssertions(baseline, [
        { id: 'passes', status: 'passed' },
        { id: 'also-passes', status: 'passed' },
      ]),
    ).not.toThrow()
  })
})
