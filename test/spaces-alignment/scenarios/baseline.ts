import type { AssertionResult, ScenarioSuite } from '../rules.js'

const requiredAssertions = [
  'browser-oauth',
  'stratos-custody',
  'pds-custody',
  'space-lexicon',
  'publication-feed',
  'boundary-isolation',
  'public-private-blob-denied',
  'authenticated-space-blob',
] as const

export const suite: ScenarioSuite = {
  id: 'baseline',
  requiredAssertions,
  async run(context): Promise<AssertionResult[]> {
    const output = await context.runCommand(
      'docker',
      [
        'compose',
        '--project-name',
        context.projectName,
        '--project-directory',
        context.sandboxDirectory,
        'run',
        '--rm',
        '--no-deps',
        'feedgen-e2e-browser',
      ],
      context.sandboxDirectory,
    )
    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const result = lines.findLast((line) =>
      line.startsWith('{"suite":"baseline","assertions":'),
    )
    if (!result)
      throw new Error('Browser runner returned no baseline assertion receipt')
    const parsed = JSON.parse(result) as {
      suite?: string
      assertions?: AssertionResult[]
    }
    if (parsed.suite !== 'baseline' || !Array.isArray(parsed.assertions)) {
      throw new Error(
        'Browser runner returned an invalid baseline assertion receipt',
      )
    }
    return parsed.assertions
  },
}
