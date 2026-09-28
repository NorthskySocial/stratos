import assert from 'node:assert/strict'
import { copyFile, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AssertionResult, ScenarioSuite } from '../rules.js'

const requiredAssertions = [
  'oauth-space-session',
  'pds-issued-delegation',
  'header-exchange',
  'foreign-repo-read',
  'wrong-key-denied',
  'delegation-replay-denied',
  'missing-proof-preserves-delegation',
  'ambiguous-transport-denied',
  'ordinary-bearer-denied',
] as const

const scenarioDirectory = dirname(fileURLToPath(import.meta.url))
const clubhousePackage = new URL(
  '../../../clubhouse/package.json',
  import.meta.url,
)

async function prepareBrowserRunner(reportDirectory: string): Promise<void> {
  const clubhouse = JSON.parse(await readFile(clubhousePackage, 'utf8')) as {
    name?: string
  }
  assert.equal(clubhouse.name, '@northskysocial/clubhouse')
  const require = createRequire(clubhousePackage)
  const vitePath = require.resolve('vite')
  const { build } = (await import(
    pathToFileURL(vitePath).href
  )) as typeof import('vite')
  await build({
    configFile: false,
    build: {
      emptyOutDir: false,
      outDir: reportDirectory,
      lib: {
        entry: join(scenarioDirectory, 'delegation-transport.browser.mjs'),
        name: 'DelegationScenarioAuth',
        formats: ['iife'],
        fileName: () => 'auth-client.iife.js',
      },
    },
  })
  await copyFile(
    join(scenarioDirectory, 'delegation-transport.driver.mjs'),
    join(reportDirectory, 'driver.mjs'),
  )
}

export const suite: ScenarioSuite = {
  id: 'delegation-transport',
  requiredAssertions,
  async run(context): Promise<AssertionResult[]> {
    await prepareBrowserRunner(context.reportDirectory)
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
        `${context.reportDirectory}:/scenario:ro`,
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
        line.startsWith('{"suite":"delegation-transport","assertions":'),
      )
    if (!receipt)
      throw new Error('Delegation browser returned no assertion receipt')
    const parsed = JSON.parse(receipt) as {
      suite?: string
      assertions?: AssertionResult[]
    }
    if (
      parsed.suite !== 'delegation-transport' ||
      !Array.isArray(parsed.assertions)
    ) {
      throw new Error(
        'Delegation browser returned an invalid assertion receipt',
      )
    }
    return parsed.assertions
  },
}
