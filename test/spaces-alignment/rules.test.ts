import { describe, expect, it } from 'vitest'
import {
  assertionsReachedBy,
  reachedAssertionIds,
  runDriverCommand,
  STANDALONE_SUITE_IDS,
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

describe('standalone suites', () => {
  it('names standalone suites', () => {
    expect([...STANDALONE_SUITE_IDS]).toEqual([
      'ordinary-custody',
      'november-positive',
    ])
  })

  it('runs a standalone suite without the baseline before it', () => {
    const suites = [
      suite('baseline'),
      suite('ordinary-custody'),
      suite('extra'),
    ]
    expect(
      suiteExecutionOrder('ordinary-custody', suites).map((item) => item.id),
    ).toEqual(['ordinary-custody'])
    expect(suiteExecutionOrder('extra', suites).map((item) => item.id)).toEqual(
      ['baseline', 'extra'],
    )
    expect(
      suiteExecutionOrder('baseline', suites).map((item) => item.id),
    ).toEqual(['baseline'])
  })

  it('still needs the baseline to be registered for a standalone suite', () => {
    expect(() =>
      suiteExecutionOrder('ordinary-custody', [suite('ordinary-custody')]),
    ).toThrow('Unknown or unavailable suite')
  })
})

describe('assertions reached before a driver failure', () => {
  const faye = suite('faye-suite', ['first-step', 'second-step'])
  const progress = (id: string, suiteId = 'faye-suite') =>
    JSON.stringify({ progress: 'assertion-reached', suite: suiteId, id })

  it('reads the progress lines of the suite, in order, once each', () => {
    const output = [
      'noise',
      progress('second-step'),
      progress('first-step'),
      progress('first-step'),
    ].join('\n')
    expect(reachedAssertionIds(faye, output)).toEqual([
      'second-step',
      'first-step',
    ])
  })

  it('ignores other suites, unknown names and malformed lines', () => {
    const output = [
      progress('first-step', 'spike-suite'),
      progress('private-token'),
      '{"progress":"assertion-reached", broken',
      '{"suite":"faye-suite","assertions":[]}',
    ].join('\n')
    expect(reachedAssertionIds(faye, output)).toEqual([])
  })

  it('attaches the reached names to a failed driver command', async () => {
    const failure = Object.assign(new Error('docker compose exited 1'), {
      stdout: `${progress('first-step')}\nsecret output`,
    })
    const error = await runDriverCommand(faye, async () => {
      throw failure
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('docker compose exited 1')
    expect(assertionsReachedBy(error)).toEqual(['first-step'])
    expect(JSON.stringify(assertionsReachedBy(error))).not.toContain('secret')
  })

  it('passes output and unrelated errors through unchanged', async () => {
    await expect(runDriverCommand(faye, async () => 'ok')).resolves.toBe('ok')
    const plain = new Error('no stdout')
    await expect(
      runDriverCommand(faye, async () => {
        throw plain
      }),
    ).rejects.toBe(plain)
    expect(assertionsReachedBy(plain)).toBeUndefined()
  })
})
