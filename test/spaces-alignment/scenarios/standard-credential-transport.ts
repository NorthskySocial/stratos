import assert from 'node:assert/strict'
import { chmod, copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AssertionResult, ScenarioSuite } from '../rules.js'

const requiredAssertions = [
  'standard-exchange',
  'stratos-read',
  'october-pds-read',
  'two-owners-one-host',
  'wrong-owner-denied',
  'wrong-key-denied',
  'tampered-token-denied',
  'same-signature-reused',
  'default-lifetime-600',
  'renewal-fresh-key',
  'renewal-after-removal-denied',
  'cross-space-denied',
  'legacy-compatible',
  'conflicting-proof-denied',
  'delegation-replay-denied',
] as const
const scenarioDirectory = dirname(fileURLToPath(import.meta.url))
const clubhousePackage = new URL(
  '../../../clubhouse/package.json',
  import.meta.url,
)
export async function prepareBrowserRunner(
  reportDirectory: string,
): Promise<string> {
  const browserAssets = join(reportDirectory, 'standard-browser-assets')
  await rm(browserAssets, { recursive: true, force: true })
  await mkdir(browserAssets)
  await chmod(browserAssets, 0o755)
  const clubhouse = JSON.parse(await readFile(clubhousePackage, 'utf8')) as {
    name?: string
  }
  assert.equal(clubhouse.name, '@northskysocial/clubhouse')
  const require = createRequire(clubhousePackage)
  const vitePath = require.resolve('vite')
  const { build } = (await import(pathToFileURL(vitePath).href)) as {
    build(options: Record<string, unknown>): Promise<void>
  }
  await build({
    configFile: false,
    build: {
      outDir: browserAssets,
      lib: {
        entry: join(
          scenarioDirectory,
          'standard-credential-transport.browser.mjs',
        ),
        name: 'DelegationScenarioAuth',
        formats: ['iife'],
        fileName: () => 'auth-client.iife.js',
      },
    },
  })
  const driverPath = join(browserAssets, 'driver.mjs')
  await copyFile(
    join(scenarioDirectory, 'standard-credential-transport.driver.mjs'),
    driverPath,
  )
  await Promise.all([
    chmod(join(browserAssets, 'auth-client.iife.js'), 0o644),
    chmod(driverPath, 0o644),
  ])
  return browserAssets
}

export const suite: ScenarioSuite = {
  id: 'standard-credential-transport',
  requiredAssertions,
  async run(context): Promise<AssertionResult[]> {
    const browserAssets = await prepareBrowserRunner(context.reportDirectory)
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
        `${browserAssets}:/scenario:ro,z`,
        '--entrypoint',
        'node',
        'feedgen-e2e-browser',
        '/scenario/driver.mjs',
      ],
      context.sandboxDirectory,
    )
    const receipt = output
      .split('\n')
      .map((line) => line.trim())
      .findLast((line) =>
        line.startsWith(
          '{"suite":"standard-credential-transport","assertions":',
        ),
      )
    if (!receipt)
      throw new Error('Delegation browser returned no assertion receipt')
    const parsed = JSON.parse(receipt) as {
      suite?: string
      assertions?: AssertionResult[]
    }
    if (
      parsed.suite !== 'standard-credential-transport' ||
      !Array.isArray(parsed.assertions)
    ) {
      throw new Error(
        'Delegation browser returned an invalid assertion receipt',
      )
    }
    return parsed.assertions
  },
}
