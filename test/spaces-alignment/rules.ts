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
  /** What the suite leaves out, written into the receipt beside its counts. */
  coverage?: string
  run: (context: ScenarioContext) => Promise<AssertionResult[]>
}

export interface ScenarioContext {
  sandboxDirectory: string
  composeFile: string
  projectName: string
  scratchDirectory: string
  runCommand: (file: string, args: string[], cwd: string) => Promise<string>
}

/**
 * Suites the runner runs alone, without the baseline before them. Each one
 * covers a journey the baseline cannot reach on this branch, and its receipt
 * says what it leaves out.
 */
export const STANDALONE_SUITE_IDS: ReadonlySet<string> = new Set([
  'ordinary-custody',
])

const SHA = /^[0-9a-f]{40}$/
const REVIEW_MODELS = new Set(['gpt-5.6-terra', 'gpt-6.1-sol'])

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
    if (typeof review.model !== 'string') {
      throw new Error(`${kind} review model must be a string`)
    }
    if (
      !REVIEW_MODELS.has(review.model) ||
      review.verdict !== 'approved' ||
      review.reviewedSha !== candidateSha
    ) {
      throw new Error(
        `${kind} review does not approve this candidate with an accepted model`,
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
  if (selected === baseline || STANDALONE_SUITE_IDS.has(selected.id))
    return [selected]
  return [baseline, selected]
}

/**
 * A suite whose child process failed after reaching some of its assertions.
 * The runner writes the names reached into the failure report.
 */
export class SuiteFailure extends Error {
  constructor(
    message: string,
    readonly suiteId: string,
    readonly reachedAssertions: readonly string[],
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/** The assertions a failed suite reached, when it says so. */
export function assertionsReachedBy(
  error: unknown,
): readonly string[] | undefined {
  const reached = (error as { reachedAssertions?: unknown } | null)
    ?.reachedAssertions
  return error instanceof Error &&
    Array.isArray(reached) &&
    reached.every((id) => typeof id === 'string')
    ? reached
    : undefined
}

/**
 * The assertion names a driver printed as progress lines, in the order
 * printed. Only names the suite requires are returned, so the failure report
 * never carries other output.
 */
export function reachedAssertionIds(
  suite: ScenarioSuite,
  output: string,
): string[] {
  const required = new Set(suite.requiredAssertions)
  const reached: string[] = []
  for (const line of output.split('\n')) {
    const text = line.trim()
    if (!text.startsWith('{"progress":"assertion-reached"')) continue
    let parsed: { suite?: unknown; id?: unknown }
    try {
      parsed = JSON.parse(text) as { suite?: unknown; id?: unknown }
    } catch {
      continue
    }
    if (
      parsed.suite === suite.id &&
      typeof parsed.id === 'string' &&
      required.has(parsed.id) &&
      !reached.includes(parsed.id)
    )
      reached.push(parsed.id)
  }
  return reached
}

/**
 * Runs a driver command and, when it fails, reports which assertions it had
 * reached from the output it printed before failing.
 */
export async function runDriverCommand(
  suite: ScenarioSuite,
  run: () => Promise<string>,
): Promise<string> {
  try {
    return await run()
  } catch (error) {
    const stdout = (error as { stdout?: unknown } | null)?.stdout
    if (typeof stdout !== 'string') throw error
    throw new SuiteFailure(
      error instanceof Error ? error.message : `${suite.id} driver failed`,
      suite.id,
      reachedAssertionIds(suite, stdout),
      { cause: error },
    )
  }
}
