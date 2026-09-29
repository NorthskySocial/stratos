import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { validateAssertions } from '../rules.js'
import { parseReceipt, suite } from './authority-contract.js'

const directories: string[] = []

async function privateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'authority-contract-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  )
})

function receipt(suiteId: string, ids: readonly string[]): string {
  return JSON.stringify({
    suite: suiteId,
    assertions: ids.map((id) => ({ id, status: 'passed' })),
  })
}

const browserIds = [
  'production-role-absent',
  'delegated-dpop-exchange',
  'credential-read-and-wrong-key',
  'pds-signed-head',
  'standard-routes-unsupported',
]
const wireIds = ['mixed-custody-hash-gap', 'unsolicited-writer-not-admitted']

it('runs real browser and identity-container probes with a private fixture', async () => {
  const directory = await privateDirectory()
  const runCommand = vi
    .fn()
    .mockResolvedValueOnce(
      `${receipt('authority-contract-browser', browserIds)}\n`,
    )
    .mockResolvedValueOnce(`${receipt('authority-contract-wire', wireIds)}\n`)
  const assertions = await suite.run({
    sandboxDirectory: directory,
    reportDirectory: directory,
    projectName: 'd01-test',
    runCommand,
  })
  validateAssertions(suite, assertions)
  expect(assertions).toHaveLength(7)
  expect(runCommand).toHaveBeenCalledTimes(2)
  const browserArgs = runCommand.mock.calls[0][1] as string[]
  const wireArgs = runCommand.mock.calls[1][1] as string[]
  expect(browserArgs).toContain('/scenario/authority-contract.browser.mjs')
  expect(wireArgs).toContain('/scenario/authority-contract.probe.mjs')
  expect(wireArgs).toContain('--allow-net=feedgen-e2e-stratos:3100')
  const compose = [
    'compose',
    '--project-name',
    'd01-test',
    '--project-directory',
    directory,
  ]
  expect(runCommand).toHaveBeenNthCalledWith(
    1,
    'docker',
    [
      ...compose,
      'run',
      '--rm',
      '--no-deps',
      '--volume',
      `${directory}/authority-contract-assets:/scenario:ro,z`,
      '--entrypoint',
      'node',
      'feedgen-e2e-browser',
      '/scenario/authority-contract.browser.mjs',
    ],
    directory,
  )
  expect(runCommand).toHaveBeenNthCalledWith(
    2,
    'docker',
    [
      ...compose,
      'run',
      '--rm',
      '--no-deps',
      '--volume',
      `${directory}/authority-contract-assets:/scenario:ro,z`,
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
    directory,
  )
  expect(browserArgs).toContain(
    `${directory}/authority-contract-assets:/scenario:ro,z`,
  )
  expect(wireArgs).toContain(
    `${directory}/authority-contract-assets:/scenario:ro,z`,
  )
  for (const name of [
    'auth-client.iife.js',
    'authority-contract.browser.mjs',
    'authority-contract.discovery.mjs',
    'authority-contract.probe.mjs',
    'authority-contract.adapter.ts',
  ]) {
    expect(
      (await readFile(join(directory, 'authority-contract-assets', name)))
        .length,
    ).toBeGreaterThan(0)
  }
})

it('rejects malformed or empty assertion receipts', () => {
  const expected = 'authority-contract-browser'
  expect(suite.id).toBe('authority-contract')
  expect(
    parseReceipt(`  ${receipt(expected, browserIds)}  \n`, expected),
  ).toHaveLength(5)
  for (const invalid of [
    JSON.stringify({
      suite: 'other',
      assertions: [{ id: 'probe', status: 'passed' }],
    }),
    JSON.stringify({ suite: expected, assertions: [] }),
    JSON.stringify({
      suite: expected,
      assertions: [{ id: 42, status: 'passed' }],
    }),
    JSON.stringify({
      suite: expected,
      assertions: [{ id: 'probe', status: 'failed' }],
    }),
    JSON.stringify({
      suite: expected,
      assertions: [
        { id: 'good', status: 'passed' },
        { id: 'bad', status: 'failed' },
      ],
    }),
  ]) {
    expect(() => parseReceipt(invalid, expected)).toThrow()
  }
})

it('rejects a missing browser receipt', async () => {
  const directory = await privateDirectory()
  const runCommand = vi.fn().mockResolvedValue('health only')
  await expect(
    suite.run({
      sandboxDirectory: directory,
      reportDirectory: directory,
      projectName: 'd01-test',
      runCommand,
    }),
  ).rejects.toThrow('authority-contract-browser returned no assertion receipt')
  expect(runCommand).toHaveBeenCalledTimes(1)
})

it('rejects a failed wire assertion', async () => {
  const directory = await privateDirectory()
  const runCommand = vi
    .fn()
    .mockResolvedValueOnce(receipt('authority-contract-browser', browserIds))
    .mockResolvedValueOnce(
      JSON.stringify({
        suite: 'authority-contract-wire',
        assertions: [{ id: wireIds[0], status: 'failed' }],
      }),
    )
  await expect(
    suite.run({
      sandboxDirectory: directory,
      reportDirectory: directory,
      projectName: 'd01-test',
      runCommand,
    }),
  ).rejects.toThrow(
    'authority-contract-wire returned an invalid assertion receipt',
  )
})
