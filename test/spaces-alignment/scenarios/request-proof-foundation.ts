import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  validateAssertions,
  type AssertionResult,
  type ScenarioSuite,
} from '../rules.js'

export const suite: ScenarioSuite = {
  id: 'request-proof-foundation',
  requiredAssertions: [
    'invalid-admission-preserves-proof',
    'distributed-concurrent-single-consume',
    'expiry-plus-skew-retained',
    'fresh-proof-retry',
    'unavailable-storage-fails-closed',
  ],
  async run(context): Promise<AssertionResult[]> {
    const assets = join(context.reportDirectory, 'foundation-assets')
    await mkdir(assets, { recursive: true })
    await chmod(assets, 0o755)
    const driver = join(assets, 'driver.mjs')
    await copyFile(
      new URL('./request-proof-foundation.driver.mjs', import.meta.url),
      driver,
    )
    await chmod(driver, 0o644)
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
        '--volume',
        `${assets}:/scenario:ro,z`,
        '--entrypoint',
        'node',
        'feedgen-e2e-stratos',
        '/scenario/driver.mjs',
      ],
      context.sandboxDirectory,
    )
    const receipt = output
      .split('\n')
      .map((line) => line.trim())
      .findLast((line) =>
        line.startsWith('{"suite":"request-proof-foundation",'),
      )
    if (!receipt) throw new Error('Foundation returned no assertion receipt')
    const parsed = JSON.parse(receipt) as {
      suite?: string
      assertions?: AssertionResult[]
    }
    if (parsed.suite !== suite.id || !Array.isArray(parsed.assertions))
      throw new Error('Foundation returned an invalid assertion receipt')
    validateAssertions(suite, parsed.assertions)
    if (parsed.assertions.length !== suite.requiredAssertions.length)
      throw new Error('Foundation returned unexpected assertions')
    return parsed.assertions
  },
}
