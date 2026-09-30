export interface ReviewEntry {
  model: string
  verdict: string
  reviewedSha: string
  sessionId: string
  unresolvedBlockingFindings: number
  evidenceRef: string
}

export interface ReviewReceipt {
  candidateSha: string
  baseSha: string
  reviews: { standards: ReviewEntry; spec: ReviewEntry }
}

export interface AssertionResult {
  id: string
  status: 'passed' | 'failed' | 'skipped'
  detail?: string
}

export interface ScenarioSuite {
  id: string
  requiredAssertions: readonly string[]
  run: (context: ScenarioContext) => Promise<AssertionResult[]>
}

export interface ScenarioContext {
  sandboxDirectory: string
  composeFile: string
  projectName: string
  reportDirectory: string
  runCommand: (file: string, args: string[], cwd: string) => Promise<string>
}

const SHA = /^[0-9a-f]{40}$/

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object')
  }
  return value as Record<string, unknown>
}

export function validateReviewReceipt(
  value: unknown,
  candidateSha: string,
  baseSha: string,
): ReviewReceipt {
  const receipt = record(value)
  if (
    !SHA.test(candidateSha) ||
    !SHA.test(baseSha) ||
    candidateSha === baseSha
  ) {
    throw new Error('Candidate and base must be distinct full Git SHAs')
  }
  if (receipt.candidateSha !== candidateSha || receipt.baseSha !== baseSha) {
    throw new Error('Review receipt does not match the candidate and base')
  }
  const reviews = record(receipt.reviews)
  for (const kind of ['standards', 'spec'] as const) {
    const review = record(reviews[kind])
    if (
      review.model !== 'gpt-5.6-terra' ||
      review.verdict !== 'approved' ||
      review.reviewedSha !== candidateSha
    ) {
      throw new Error(
        `${kind} review does not approve this candidate with Terra`,
      )
    }
    if (
      typeof review.sessionId !== 'string' ||
      review.sessionId.length === 0 ||
      typeof review.evidenceRef !== 'string' ||
      review.evidenceRef.length === 0 ||
      review.unresolvedBlockingFindings !== 0
    ) {
      throw new Error(
        `${kind} review has missing evidence or blocking findings`,
      )
    }
  }
  if (record(reviews.standards).sessionId === record(reviews.spec).sessionId) {
    throw new Error('Standards and Spec require separate review sessions')
  }
  return value as ReviewReceipt
}

export function validateSuite(suite: ScenarioSuite): void {
  if (
    !/^[a-z][a-z0-9-]*$/.test(suite.id) ||
    suite.requiredAssertions.length === 0 ||
    new Set(suite.requiredAssertions).size !==
      suite.requiredAssertions.length ||
    suite.requiredAssertions.some((id) => !/^[a-z][a-z0-9-]*$/.test(id))
  ) {
    throw new Error(`Invalid suite declaration: ${suite.id}`)
  }
  if (typeof suite.run !== 'function')
    throw new Error(`Suite ${suite.id} has no runner`)
}

export function validateAssertions(
  suite: ScenarioSuite,
  results: AssertionResult[],
): void {
  if (!Array.isArray(results) || results.length === 0)
    throw new Error(`${suite.id} returned zero assertions`)
  const seen = new Set<string>()
  for (const result of results) {
    if (seen.has(result.id))
      throw new Error(`${suite.id} returned duplicate assertion ${result.id}`)
    seen.add(result.id)
    if (result.status !== 'passed')
      throw new Error(`${suite.id} assertion ${result.id} is ${result.status}`)
  }
  for (const id of suite.requiredAssertions) {
    if (!seen.has(id))
      throw new Error(`${suite.id} omitted required assertion ${id}`)
  }
}

export function suiteExecutionOrder(
  requested: string,
  suites: ScenarioSuite[],
): ScenarioSuite[] {
  const ids = new Set<string>()
  for (const suite of suites) {
    validateSuite(suite)
    if (ids.has(suite.id)) throw new Error(`Duplicate suite ${suite.id}`)
    ids.add(suite.id)
  }
  const baseline = suites.find((suite) => suite.id === 'baseline')
  const selected = suites.find((suite) => suite.id === requested)
  if (!baseline || !selected)
    throw new Error(`Unknown or unavailable suite: ${requested}`)
  return selected === baseline ? [baseline] : [baseline, selected]
}
