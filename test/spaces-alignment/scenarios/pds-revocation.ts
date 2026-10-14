import { fileURLToPath } from 'node:url'
import type { AssertionResult, ScenarioSuite } from '../rules.js'

const requiredAssertions = [
  'late-page-revoked',
  'late-terminal-verification-revoked',
  'other-member-preserved',
  'old-generation-rejection-observed',
  'fresh-generation-recovers',
  'restart-keeps-revocation',
] as const

export const suite: ScenarioSuite = {
  id: 'pds-revocation',
  requiredAssertions,
  async run(context): Promise<AssertionResult[]> {
    const output = await context.runCommand(
      'node',
      [
        fileURLToPath(new URL('./pds-revocation.mjs', import.meta.url)),
        context.sandboxDirectory,
        context.projectName,
      ],
      context.sandboxDirectory,
    )
    const receipt = output
      .split('\n')
      .map((line) => line.trim())
      .findLast((line) =>
        line.startsWith('{"suite":"pds-revocation","assertions":'),
      )
    if (!receipt)
      throw new Error('PDS revocation returned no assertion receipt')
    const parsed = JSON.parse(receipt) as {
      suite?: string
      assertions?: AssertionResult[]
    }
    if (parsed.suite !== 'pds-revocation' || !Array.isArray(parsed.assertions))
      throw new Error('PDS revocation returned an invalid assertion receipt')
    return parsed.assertions
  },
}
