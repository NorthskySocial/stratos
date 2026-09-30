import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { validateAssertions } from '../rules.js'
import { suite } from './space-delete.js'

const directories: string[] = []

async function sandbox(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'space-delete-'))
  directories.push(directory)
  await mkdir(join(directory, 'stacks'))
  await mkdir(join(directory, 'state'))
  await writeFile(join(directory, 'stacks/components.json'), '[]')
  return directory
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

it('adds the candidate webapp with private OAuth routing', async () => {
  expect(suite.id).toBe('space-delete')
  expect(suite.requiredAssertions).toEqual([
    'webapp-oauth-delete-grant',
    'pds-delete-target',
    'feed-removes-only-target',
    'other-author-denied',
    'stratos-delete-preserved',
  ])
  const sandboxDirectory = await sandbox()
  await writeFile(
    join(sandboxDirectory, 'stacks/components.json'),
    '[{"id":"existing-app"}]',
  )
  const runCommand = vi
    .fn()
    .mockResolvedValueOnce('applied')
    .mockResolvedValueOnce('ready')
    .mockResolvedValueOnce('routes reloaded')
    .mockResolvedValueOnce('PDS restarted')
    .mockResolvedValueOnce('ready after restart')
    .mockResolvedValueOnce(
      `  ${JSON.stringify({
        suite: 'space-delete',
        assertions: [
          'webapp-oauth-delete-grant',
          'pds-delete-target',
          'feed-removes-only-target',
          'other-author-denied',
          'stratos-delete-preserved',
        ].map((id) => ({ id, status: 'passed' })),
      })}\ncompose teardown`,
    )

  const assertions = await suite.run({
    sandboxDirectory,
    projectName: 'space-delete-test',
    reportDirectory: sandboxDirectory,
    runCommand,
  })
  validateAssertions(suite, assertions)

  const components = JSON.parse(
    await readFile(join(sandboxDirectory, 'stacks/components.json'), 'utf8'),
  ) as unknown[]
  expect(components).toEqual([
    { id: 'existing-app' },
    {
      id: 'space-delete-webapp',
      file: 'stacks/space-delete-webapp.yaml',
      application: 'space-delete-webapp',
      definition: 'stacks/space-delete-webapp.definition.json',
    },
  ])
  const definition = JSON.parse(
    await readFile(
      join(sandboxDirectory, 'stacks/space-delete-webapp.definition.json'),
      'utf8',
    ),
  ) as Record<string, unknown>
  expect(definition).toEqual({
    version: 1,
    id: 'space-delete-webapp',
    services: [
      {
        service: 'space-delete-webapp',
        environment: [],
        buildArguments: [
          {
            name: 'VITE_STRATOS_SERVICE_DID',
            source: { kind: 'web-did', host: 'stratos-e2e' },
          },
          {
            name: 'VITE_STRATOS_URL',
            source: { kind: 'host-url', host: 'stratos-e2e' },
          },
          {
            name: 'VITE_ATPROTO_HANDLE_RESOLVER',
            source: { kind: 'host-url', host: 'spaces-pds-e2e' },
          },
          {
            name: 'VITE_PLC_DIRECTORY',
            source: { kind: 'host-url', host: 'plc' },
          },
          {
            name: 'VITE_FEEDGEN_DID',
            source: { kind: 'web-did', host: 'feedgen-e2e' },
          },
        ],
      },
    ],
    routes: [
      {
        id: 'space-delete-webapp',
        service: 'space-delete-webapp',
        host: 'webapp-e2e',
        port: 80,
      },
      {
        id: 'space-delete-webapp-oauth',
        service: 'space-delete-webapp',
        hostname: 'webapp-e2e.atmosbox.internal',
        port: 80,
      },
    ],
    secrets: [],
  })
  const compose = await readFile(
    join(sandboxDirectory, 'stacks/space-delete-webapp.yaml'),
    'utf8',
  )
  for (const expected of [
    'context: ../stratos',
    'dockerfile: webapp/Dockerfile',
    'VITE_FEEDGEN_FEED: general',
    'VITE_WEBAPP_URL: https://webapp-e2e.atmosbox.internal',
    'read_only: true',
    'healthcheck:',
  ])
    expect(compose).toContain(expected)
  expect(runCommand.mock.calls.map(([program]) => program)).toEqual([
    'deno',
    'deno',
    'docker',
    'docker',
    'deno',
    'docker',
  ])
  expect(runCommand.mock.calls[0]?.[1]).toEqual([
    'task',
    'sandbox',
    'apply',
    '--app',
    'space-delete-webapp',
  ])
  expect(runCommand.mock.calls[1]?.[1]).toEqual([
    'task',
    'sandbox',
    'up',
    '--build',
  ])
  expect(runCommand.mock.calls[2]?.[1]).toEqual([
    'compose',
    '--project-name',
    'space-delete-test',
    '--project-directory',
    sandboxDirectory,
    'restart',
    'dns',
    'gateway',
  ])
  expect(runCommand.mock.calls[3]?.[1]).toEqual([
    'compose',
    '--project-name',
    'space-delete-test',
    '--project-directory',
    sandboxDirectory,
    'restart',
    'feedgen-e2e-pds-spaces',
  ])
  expect(runCommand.mock.calls[4]?.[1]).toEqual(['task', 'sandbox', 'up'])
  expect(runCommand.mock.calls[5]?.[1]).toEqual(
    expect.arrayContaining([
      'compose',
      '--project-name',
      'space-delete-test',
      '--project-directory',
      sandboxDirectory,
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'node',
      'feedgen-e2e-browser',
      '/runner/space-delete.browser.mjs',
    ]),
  )
  const dockerArgs = runCommand.mock.calls[5]?.[1] as string[]
  const volume = dockerArgs[dockerArgs.indexOf('--volume') + 1]
  expect(volume).toBe(
    `${sandboxDirectory}/state/space-delete.browser.mjs:/runner/space-delete.browser.mjs:ro,Z`,
  )
  expect(
    await readFile(join(sandboxDirectory, 'state/space-delete.browser.mjs')),
  ).toEqual(
    await readFile(new URL('./space-delete.browser.mjs', import.meta.url)),
  )
})

it('rejects an empty browser receipt', async () => {
  const sandboxDirectory = await sandbox()
  const runCommand = vi
    .fn()
    .mockResolvedValueOnce('applied')
    .mockResolvedValueOnce('ready')
    .mockResolvedValueOnce('routes reloaded')
    .mockResolvedValueOnce('PDS restarted')
    .mockResolvedValueOnce('ready after restart')
    .mockResolvedValueOnce('')
  await expect(
    suite.run({
      sandboxDirectory,
      projectName: 'space-delete-test',
      reportDirectory: sandboxDirectory,
      runCommand,
    }),
  ).rejects.toThrow('Browser returned no space-delete receipt')
})

it('rejects malformed browser assertions', async () => {
  const sandboxDirectory = await sandbox()
  const runCommand = vi
    .fn()
    .mockResolvedValueOnce('applied')
    .mockResolvedValueOnce('ready')
    .mockResolvedValueOnce('routes reloaded')
    .mockResolvedValueOnce('PDS restarted')
    .mockResolvedValueOnce('ready after restart')
    .mockResolvedValueOnce('{"suite":"space-delete","assertions":{}}')
  await expect(
    suite.run({
      sandboxDirectory,
      projectName: 'space-delete-test',
      reportDirectory: sandboxDirectory,
      runCommand,
    }),
  ).rejects.toThrow('Browser returned an invalid space-delete receipt')
})

it('does not register the app twice', async () => {
  const sandboxDirectory = await sandbox()
  await writeFile(
    join(sandboxDirectory, 'stacks/components.json'),
    '[{"id":"space-delete-webapp"}]',
  )
  const runCommand = vi.fn()
  await expect(
    suite.run({
      sandboxDirectory,
      projectName: 'space-delete-test',
      reportDirectory: sandboxDirectory,
      runCommand,
    }),
  ).rejects.toThrow('Disposable sandbox already has the space-delete app')
  expect(runCommand).not.toHaveBeenCalled()
})
