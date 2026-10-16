import { chmod, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AssertionResult, ScenarioSuite } from '../rules.js'
import { validateAssertions } from '../rules.js'
import { prepareBrowserRunner } from './standard-credential-transport.js'
import { requiredAssertions } from './writer-sync-contract.driver.mjs'

export const suite: ScenarioSuite = {
  id: 'writer-sync-contract',
  requiredAssertions,
  async run(context): Promise<AssertionResult[]> {
    const assets = await prepareBrowserRunner(context.reportDirectory)
    await copyFile(
      join(assets, 'driver.mjs'),
      join(assets, 'standard-credential-transport.driver.mjs'),
    )
    const driver = join(assets, 'writer-sync-contract.driver.mjs')
    await copyFile(
      new URL('./writer-sync-contract.driver.mjs', import.meta.url),
      driver,
    )
    await chmod(driver, 0o644)
    const output = await context.runCommand(
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
        '--rm',
        '--no-deps',
        '--volume',
        `${assets}:/scenario:ro,z`,
        '--entrypoint',
        'node',
        'feedgen-e2e-browser',
        '/scenario/writer-sync-contract.driver.mjs',
      ],
      context.sandboxDirectory,
    )
    const parsed = JSON.parse(output) as {
      suite: string
      assertions: AssertionResult[]
    }
    if (parsed.suite !== suite.id)
      throw new Error('Unexpected writer-sync receipt')
    validateAssertions(suite, parsed.assertions)
    return parsed.assertions
  },
}
