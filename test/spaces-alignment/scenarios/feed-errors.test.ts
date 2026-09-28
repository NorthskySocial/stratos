import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { validateAssertions } from '../rules.js'
import { suite } from './feed-errors.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function waitFor(directory: string, name: string) {
  const file = join(directory, name)
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (
      await stat(file)
        .then(() => true)
        .catch(() => false)
    )
      return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Test browser did not receive ${name}`)
}

async function harness(did: string, revocationOutput = 'revoked:1') {
  const sandboxDirectory = await mkdtemp(join(tmpdir(), 'feed-errors-'))
  directories.push(sandboxDirectory)
  await mkdir(join(sandboxDirectory, 'stacks'))
  await mkdir(join(sandboxDirectory, 'state'))
  await writeFile(join(sandboxDirectory, 'stacks/components.json'), '[]')
  const control = join(sandboxDirectory, 'state/feed-errors-control')
  const runCommand = vi.fn(async (program: string, args: string[]) => {
    if (program !== 'docker') return ''
    if (args.includes('run')) {
      await writeFile(join(control, 'ready'), '')
      await waitFor(control, 'interrupted')
      await writeFile(join(control, 'failed'), '')
      await waitFor(control, 'restored')
      await writeFile(join(control, 'revoke-did'), `  ${did}\n`)
      if (did === 'did:plc:motoko' && revocationOutput === 'revoked:1') {
        await waitFor(control, 'revoked')
      } else {
        return new Promise<string>(() => {})
      }
      return JSON.stringify({
        suite: 'feed-errors',
        assertions: suite.requiredAssertions.map((id) => ({
          id,
          status: 'passed',
        })),
      })
    }
    if (args.includes('exec')) return revocationOutput
    return ''
  })

  return { sandboxDirectory, control, runCommand }
}

it('revokes the test webapp grant before releasing the denied browser request', async () => {
  const did = 'did:plc:motoko'
  const { sandboxDirectory, control, runCommand } = await harness(did)

  const assertions = await suite.run({
    sandboxDirectory,
    projectName: 'feed-errors-test',
    reportDirectory: sandboxDirectory,
    runCommand,
  })
  validateAssertions(suite, assertions)
  const revocation = runCommand.mock.calls.find(([, args]) =>
    args.includes('exec'),
  )
  expect(revocation?.[1]).toEqual(
    expect.arrayContaining([
      'feedgen-e2e-pds-spaces',
      did,
      'https://webapp-e2e.atmosbox.internal/client-metadata.json',
    ]),
  )
  const command = revocation?.[1] as string[]
  expect(command.slice(command.indexOf('exec'))).toEqual([
    'exec',
    '-T',
    'feedgen-e2e-pds-spaces',
    'node',
    '-e',
    expect.stringContaining('DELETE FROM token WHERE did = ? AND clientId = ?'),
    did,
    'https://webapp-e2e.atmosbox.internal/client-metadata.json',
  ])
  expect(await readFile(join(control, 'revoked'), 'utf8')).toBe('')
})

it.each(['x-did:plc:motoko', 'did:plc:motoko!'])(
  'rejects a browser DID outside the test PDS DID format: %s',
  async (did) => {
    const { sandboxDirectory, runCommand } = await harness(did)
    await expect(
      suite.run({
        sandboxDirectory,
        projectName: 'feed-errors-test',
        reportDirectory: sandboxDirectory,
        runCommand,
      }),
    ).rejects.toThrow('invalid test account DID')
    expect(
      runCommand.mock.calls.some(([, args]) => args.includes('exec')),
    ).toBe(false)
  },
)

it.each(['revoked:1x', 'prefixrevoked:1'])(
  'does not release the browser when grant deletion is unconfirmed: %s',
  async (revocationOutput) => {
    const { sandboxDirectory, control, runCommand } = await harness(
      'did:plc:motoko',
      revocationOutput,
    )
    await expect(
      suite.run({
        sandboxDirectory,
        projectName: 'feed-errors-test',
        reportDirectory: sandboxDirectory,
        runCommand,
      }),
    ).rejects.toThrow('grant revocation was not confirmed')
    expect(
      await stat(join(control, 'revoked'))
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
  },
)
