import { readFile, writeFile } from 'node:fs/promises'
import type { AssertionResult, ScenarioSuite } from '../rules.js'
import { validateAssertions } from '../rules.js'
import { suite as standard } from './standard-credential-transport.js'
import {
  suite as rust,
  runSecondOwnerIngestion,
  runRustProbe,
} from './rust-production-interop.js'

export const suite: ScenarioSuite = {
  id: 'october-interop',
  requiredAssertions: [
    ...standard.requiredAssertions,
    ...rust.requiredAssertions,
  ],
  async run(context): Promise<AssertionResult[]> {
    const standardResults = await standard.run(context)
    validateAssertions(standard, standardResults)
    const compose = await readFile(context.composeFile, 'utf8')
    const port = /^(\s+)STRATOS_PORT: ["']?3100["']?$/m
    if (
      !port.test(compose) ||
      compose.includes('STRATOS_SPACE_HTTP_CREDENTIAL_TTL_SECONDS')
    )
      throw new Error(
        'Combined suite requires the default standard credential lifetime',
      )
    await writeFile(
      context.composeFile,
      compose.replace(
        port,
        "$1STRATOS_SPACE_HTTP_CREDENTIAL_TTL_SECONDS: '10'\n$&",
      ),
    )
    await context.runCommand(
      'docker',
      [
        'compose',
        '--file',
        context.composeFile,
        '--project-name',
        context.projectName,
        '--project-directory',
        context.sandboxDirectory,
        'up',
        '--detach',
        '--no-deps',
        '--force-recreate',
        '--wait',
        'feedgen-e2e-stratos',
      ],
      context.sandboxDirectory,
    )
    const ingestion = await runSecondOwnerIngestion(context)
    const rustResults = [...ingestion, ...(await runRustProbe(context))]
    validateAssertions(rust, rustResults)
    return [...standardResults, ...rustResults]
  },
}
