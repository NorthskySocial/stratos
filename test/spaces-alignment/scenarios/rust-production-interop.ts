import { copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type {
  AssertionResult,
  ScenarioContext,
  ScenarioSuite,
} from '../rules.js'
import { validateAssertions } from '../rules.js'
import { suite as baseline } from './baseline.js'
import { prepareBrowserRunner } from './standard-credential-transport.js'

const driver = fileURLToPath(
  new URL('./rust-production-interop.driver.mjs', import.meta.url),
)
const requiredAssertions = [
  'rust-second-owner-ingestion',
  'rust-manager-expiry-refresh',
  'rust-standard-exchange',
  'rust-stratos-read',
  'rust-october-pds-read',
  'rust-two-owners-one-host',
  'rust-wrong-owner-denied',
  'rust-wrong-key-denied',
  'rust-same-signature-reused',
  'rust-renewal-fresh-key',
  'rust-renewal-after-removal-denied',
]

export async function runSecondOwnerIngestion(
  context: ScenarioContext,
): Promise<AssertionResult[]> {
  const results = await baseline.run({
    ...context,
    async runCommand(file, args, cwd) {
      const command = [...args]
      command.splice(-1, 0, '--env', 'FEEDGEN_E2E_PDS_ACCOUNT=batou')
      return context.runCommand(file, command, cwd)
    },
  })
  validateAssertions(baseline, results)
  return [{ id: 'rust-second-owner-ingestion', status: 'passed' }]
}

export async function runRustProbe(
  context: ScenarioContext,
): Promise<AssertionResult[]> {
  const assets = await prepareBrowserRunner(context.scratchDirectory)
  await copyFile(
    join(assets, 'driver.mjs'),
    join(assets, 'standard-credential-transport.driver.mjs'),
  )
  await copyFile(driver, join(assets, 'rust-production-interop.driver.mjs'))
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
      '/scenario/rust-production-interop.driver.mjs',
    ],
    context.sandboxDirectory,
  )
  const line = output
    .split('\n')
    .map((line) => line.trim())
    .findLast((line) =>
      line.startsWith('{"suite":"rust-production-interop","assertions":'),
    )
  if (!line) throw new Error('Rust probe returned no assertion receipt')
  const parsed = JSON.parse(line) as {
    suite?: string
    assertions?: AssertionResult[]
  }
  if (parsed.suite !== suite.id || !Array.isArray(parsed.assertions))
    throw new Error('Rust probe returned an invalid assertion receipt')
  validateAssertions(
    { ...suite, requiredAssertions: requiredAssertions.slice(1) },
    parsed.assertions,
  )
  return parsed.assertions
}

export const suite: ScenarioSuite = {
  id: 'rust-production-interop',
  requiredAssertions,
  async run(context): Promise<AssertionResult[]> {
    const ingestion = await runSecondOwnerIngestion(context)
    return [...ingestion, ...(await runRustProbe(context))]
  },
}
