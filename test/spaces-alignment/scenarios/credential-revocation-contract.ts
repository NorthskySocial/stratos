import { chmod, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AssertionResult, ScenarioSuite } from '../rules.js'
import { validateAssertions } from '../rules.js'
import { prepareBrowserRunner } from './standard-credential-transport.js'

export const probePipeline = `set -euo pipefail
file=$1; project=$2; directory=$3; assets=$4
compose() { docker compose --file "$file" --project-name "$project" --project-directory "$directory" "$@"; }
run() { compose run --rm --no-deps -T --volume "$assets:/scenario:ro,z" --entrypoint node "$1" /scenario/credential-revocation-contract.driver.mjs "$2"; }
run feedgen-e2e-browser prepare |
run feedgen-e2e-stratos before |
(
  state=$(</dev/stdin)
  compose restart feedgen-e2e-pds-october >/dev/null
  compose up --wait --no-deps feedgen-e2e-pds-october >/dev/null
  printf '%s' "$state" | run feedgen-e2e-browser after
)`

export const suite: ScenarioSuite = {
  id: 'credential-revocation-contract',
  requiredAssertions: [
    'upstream-two-grants-read',
    'upstream-wrong-issuer-denied',
    'upstream-foreign-audience-denied',
    'upstream-service-audience-denied',
    'upstream-wrong-method-denied',
    'upstream-missing-method-denied',
    'upstream-malformed-batch-denied',
    'upstream-cross-space-isolation',
    'upstream-grant-a-revoked-b-unaffected',
    'upstream-duplicate-idempotence',
    'upstream-restart-retention',
    'stratos-unsupported-route',
    'stratos-unsupported-role-unadvertised',
  ],
  async run(context): Promise<AssertionResult[]> {
    const assets = await prepareBrowserRunner(context.scratchDirectory)
    await copyFile(
      join(assets, 'driver.mjs'),
      join(assets, 'standard-credential-transport.driver.mjs'),
    )
    const driver = join(assets, 'credential-revocation-contract.driver.mjs')
    await copyFile(
      new URL('./credential-revocation-contract.driver.mjs', import.meta.url),
      driver,
    )
    await chmod(driver, 0o644)
    const output = await context.runCommand(
      'bash',
      [
        '-ec',
        probePipeline,
        'credential-revocation-contract',
        context.composeFile,
        context.projectName,
        context.sandboxDirectory,
        assets,
      ],
      context.sandboxDirectory,
    )
    const parsed = JSON.parse(output) as {
      suite: string
      assertions: AssertionResult[]
    }
    if (parsed.suite !== suite.id)
      throw new Error('Unexpected revocation probe receipt')
    validateAssertions(suite, parsed.assertions)
    return parsed.assertions
  },
}
