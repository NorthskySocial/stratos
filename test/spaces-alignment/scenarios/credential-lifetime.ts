import assert from 'node:assert/strict'
import { chmod, copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AssertionResult, ScenarioSuite } from '../rules.js'

const requiredAssertions = [
  'oauth-space-session',
  'pds-issued-delegation',
  'credential-minted',
  'local-read-before-removal',
  'foreign-read-before-removal',
  'member-removed',
  'local-credential-after-removal',
  'foreign-credential-after-removal',
  'wrong-key-denied',
  'expired-local-credential-denied',
  'expired-foreign-credential-denied',
  'local-revision-denied',
  'local-deactivation-denied',
] as const

const scenarioDirectory = dirname(fileURLToPath(import.meta.url))
const clubhousePackage = new URL(
  '../../../clubhouse/package.json',
  import.meta.url,
)

async function prepareBrowserRunner(reportDirectory: string): Promise<string> {
  const browserAssets = join(reportDirectory, 'browser-assets')
  await rm(browserAssets, { recursive: true, force: true })
  await mkdir(browserAssets)
  await chmod(browserAssets, 0o755)
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
      outDir: browserAssets,
      lib: {
        entry: join(scenarioDirectory, 'credential-lifetime.browser.mjs'),
        name: 'DelegationScenarioAuth',
        formats: ['iife'],
        fileName: () => 'auth-client.iife.js',
      },
    },
  })
  const driverPath = join(browserAssets, 'driver.mjs')
  await copyFile(
    join(scenarioDirectory, 'credential-lifetime.driver.mjs'),
    driverPath,
  )
  const authorityPath = join(browserAssets, 'authority.mjs')
  await copyFile(
    join(scenarioDirectory, 'credential-lifetime.authority.mjs'),
    authorityPath,
  )
  await Promise.all([
    chmod(join(browserAssets, 'auth-client.iife.js'), 0o644),
    chmod(driverPath, 0o644),
    chmod(authorityPath, 0o644),
  ])
  return browserAssets
}

function assertionReceipt(output: string, suiteId: string): AssertionResult[] {
  const receipt = output
    .split('\n')
    .map((line) => line.trim())
    .findLast((line) => line.startsWith(`{"suite":"${suiteId}","assertions":`))
  if (!receipt) throw new Error(`${suiteId} returned no assertion receipt`)
  const parsed = JSON.parse(receipt) as {
    suite?: string
    assertions?: AssertionResult[]
  }
  if (parsed.suite !== suiteId || !Array.isArray(parsed.assertions))
    throw new Error(`${suiteId} returned an invalid assertion receipt`)
  return parsed.assertions
}

export const suite: ScenarioSuite = {
  id: 'credential-lifetime',
  requiredAssertions,
  async run(context): Promise<AssertionResult[]> {
    const browserAssets = await prepareBrowserRunner(context.reportDirectory)
    const browserOutput = await context.runCommand(
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
        `${browserAssets}:/scenario:ro,z`,
        '--entrypoint',
        'node',
        'feedgen-e2e-browser',
        '/scenario/driver.mjs',
      ],
      context.sandboxDirectory,
    )
    const browserAssertions = assertionReceipt(
      browserOutput,
      'credential-lifetime',
    )
    const authorityOutput = await context.runCommand(
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
        `${browserAssets}:/scenario:ro,z`,
        '--entrypoint',
        'node',
        'feedgen-e2e-stratos',
        '/scenario/authority.mjs',
      ],
      context.sandboxDirectory,
    )
    return [
      ...browserAssertions,
      ...assertionReceipt(authorityOutput, 'credential-lifetime-authority'),
    ]
  },
}
