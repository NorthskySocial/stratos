import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AssertionResult, ScenarioSuite } from '../rules.js'

const scenarioDirectory = dirname(fileURLToPath(import.meta.url))
const clubhousePackage = new URL(
  '../../../clubhouse/package.json',
  import.meta.url,
)
const requiredAssertions = [
  'production-role-absent',
  'delegated-dpop-exchange',
  'credential-read-and-wrong-key',
  'pds-signed-head',
  'standard-routes-unsupported',
  'mixed-custody-hash-gap',
  'unsolicited-writer-not-admitted',
] as const

async function prepareAssets(reportDirectory: string): Promise<string> {
  const assets = join(reportDirectory, 'authority-contract-assets')
  await mkdir(assets)
  await chmod(assets, 0o755)
  const require = createRequire(clubhousePackage)
  const vitePath = require.resolve('vite')
  const { build } = (await import(
    pathToFileURL(vitePath).href
  )) as typeof import('vite')
  await build({
    configFile: false,
    build: {
      outDir: assets,
      lib: {
        entry: join(scenarioDirectory, 'delegation-transport.browser.mjs'),
        name: 'DelegationScenarioAuth',
        formats: ['iife'],
        fileName: () => 'auth-client.iife.js',
      },
    },
  })
  await Promise.all(
    [
      'authority-contract.browser.mjs',
      'authority-contract.discovery.mjs',
      'authority-contract.probe.mjs',
      'authority-contract.adapter.ts',
    ].map(async (name) => {
      const target = join(assets, name)
      await copyFile(join(scenarioDirectory, name), target)
      await chmod(target, 0o644)
    }),
  )
  await chmod(join(assets, 'auth-client.iife.js'), 0o644)
  return assets
}

export function parseReceipt(
  output: string,
  suiteId: string,
): AssertionResult[] {
  const receipt = output
    .split('\n')
    .map((line) => line.trim())
    .findLast((line) => line.startsWith(`{"suite":"${suiteId}","assertions":`))
  if (!receipt) throw new Error(`${suiteId} returned no assertion receipt`)
  const parsed = JSON.parse(receipt) as {
    suite?: string
    assertions?: AssertionResult[]
  }
  if (
    parsed.suite !== suiteId ||
    !Array.isArray(parsed.assertions) ||
    parsed.assertions.length === 0 ||
    parsed.assertions.some(
      (assertion) =>
        typeof assertion.id !== 'string' || assertion.status !== 'passed',
    )
  ) {
    throw new Error(`${suiteId} returned an invalid assertion receipt`)
  }
  return parsed.assertions
}

export const suite: ScenarioSuite = {
  id: 'authority-contract',
  requiredAssertions,
  async run(context): Promise<AssertionResult[]> {
    const assets = await prepareAssets(context.reportDirectory)
    const compose = [
      'compose',
      '--project-name',
      context.projectName,
      '--project-directory',
      context.sandboxDirectory,
    ]
    const browserOutput = await context.runCommand(
      'docker',
      [
        ...compose,
        'run',
        '--rm',
        '--no-deps',
        '--volume',
        `${assets}:/scenario:ro,z`,
        '--entrypoint',
        'node',
        'feedgen-e2e-browser',
        '/scenario/authority-contract.browser.mjs',
      ],
      context.sandboxDirectory,
    )
    const browserAssertions = parseReceipt(
      browserOutput,
      'authority-contract-browser',
    )
    const wireOutput = await context.runCommand(
      'docker',
      [
        ...compose,
        'run',
        '--rm',
        '--no-deps',
        '--volume',
        `${assets}:/scenario:ro,z`,
        '--entrypoint',
        'deno',
        'feedgen-e2e-identity',
        'run',
        '--config=/app/deno.json',
        '--cached-only',
        '--allow-env=SANDBOX_DOMAIN',
        '--allow-read=/scenario,/run/sandbox-secrets/feedgen-signing-key',
        '--allow-net=feedgen-e2e-stratos:3100',
        '/scenario/authority-contract.probe.mjs',
      ],
      context.sandboxDirectory,
    )
    const wireAssertions = parseReceipt(wireOutput, 'authority-contract-wire')
    return [...browserAssertions, ...wireAssertions]
  },
}
