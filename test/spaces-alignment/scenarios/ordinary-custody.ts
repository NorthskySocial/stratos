import { runDriverCommand } from '../rules.js'
import type { AssertionResult, ScenarioSuite } from '../rules.js'

const requiredAssertions = [
  'ordinary-sign-in',
  'ordinary-custody-post',
  'ordinary-feed-delivery',
  'ordinary-nonmember-denied',
  'ordinary-delete',
] as const

const coverage =
  'Ordinary custody only: one Stratos-custody member on the ordinary PDS. PDS custody, space credentials and the spaces PDS are not covered.'

export const suite: ScenarioSuite = {
  id: 'ordinary-custody',
  requiredAssertions,
  coverage,
  async run(context): Promise<AssertionResult[]> {
    const output = await runDriverCommand(suite, () =>
      context.runCommand(
        'docker',
        [
          'compose',
          '--file',
          context.composeFile,
          '--project-name',
          context.projectName,
          '--project-directory',
          context.sandboxDirectory,
          'run',
          '--build',
          '--rm',
          '--no-deps',
          'feedgen-e2e-browser',
          'ordinary-custody',
        ],
        context.sandboxDirectory,
      ),
    )
    const result = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .findLast(
        (line) =>
          line.startsWith('{"suite":"ordinary-custody","assertions":') ||
          line.startsWith('{"suite":"ordinary-custody","coverage":'),
      )
    if (!result)
      throw new Error(
        'Browser runner returned no ordinary-custody assertion receipt',
      )
    const parsed = JSON.parse(result) as {
      suite?: string
      coverage?: string
      assertions?: AssertionResult[]
    }
    if (
      parsed.suite !== 'ordinary-custody' ||
      parsed.coverage !== coverage ||
      !Array.isArray(parsed.assertions)
    ) {
      throw new Error(
        'Browser runner returned an invalid ordinary-custody assertion receipt',
      )
    }
    return parsed.assertions
  },
}
