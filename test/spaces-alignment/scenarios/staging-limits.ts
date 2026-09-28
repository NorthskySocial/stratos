import { fileURLToPath } from 'node:url'
import type { AssertionResult, ScenarioSuite } from '../rules.js'

export const suite: ScenarioSuite = {
  id: 'staging-limits',
  requiredAssertions: [
    'cumulative-pass-budget',
    'storage-accounting',
    'service-responsive',
    'interrupted-stage',
    'expired-stage-restart',
  ],
  async run(context): Promise<AssertionResult[]> {
    const output = await context.runCommand(
      'node',
      [
        fileURLToPath(new URL('./staging-limits.mjs', import.meta.url)),
        context.sandboxDirectory,
        context.projectName,
      ],
      context.sandboxDirectory,
    )
    const receipt = output
      .split('\n')
      .map((line) => line.trim())
      .findLast((line) => line.startsWith('{"suite":"staging-limits","assertions":'))
    if (!receipt) throw new Error('Staging limits returned no assertion receipt')
    const parsed = JSON.parse(receipt) as {
      suite?: string
      assertions?: AssertionResult[]
    }
    if (parsed.suite !== 'staging-limits' || !Array.isArray(parsed.assertions)) {
      throw new Error('Staging limits returned an invalid assertion receipt')
    }
    return parsed.assertions
  },
}
