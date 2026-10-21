import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readFile, stat, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { probePipeline, suite } from './credential-revocation-contract.js'
import { validateAssertions } from '../rules.js'

describe('credential revocation contract suite', () => {
  it('executes the pipe-only Compose protocol and propagates every phase failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'revocation-pipes-'))
    const docker = join(directory, 'docker')
    await writeFile(
      docker,
      `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$CALLS"
[[ "$1 $2 $3 $4 $5 $6 $7" == 'compose --file /tmp/nerv/compose.yaml --project-name nerv --project-directory /tmp/nerv' ]]
case "$*" in
  *'browser /scenario/credential-revocation-contract.driver.mjs prepare')
    [[ "$FAIL" != prepare ]]; printf 'synthetic-pipe-state' ;;
  *'stratos /scenario/credential-revocation-contract.driver.mjs before')
    [[ "$(</dev/stdin)" == synthetic-pipe-state ]]; [[ "$FAIL" != before ]]; printf 'revoked-pipe-state' ;;
  *'restart feedgen-e2e-pds-october') [[ "$FAIL" != restart ]] ;;
  *'up --wait --no-deps feedgen-e2e-pds-october') [[ "$FAIL" != health ]] ;;
  *'browser /scenario/credential-revocation-contract.driver.mjs after')
    [[ "$(</dev/stdin)" == revoked-pipe-state ]]; [[ "$FAIL" != after ]]; printf 'receipt-only' ;;
  *) exit 90 ;;
esac
`,
    )
    await chmod(docker, 0o700)
    const execute = (failure: string) =>
      promisify(execFile)(
        'bash',
        [
          '-ec',
          probePipeline,
          suite.id,
          '/tmp/nerv/compose.yaml',
          'nerv',
          '/tmp/nerv',
          directory,
        ],
        {
          env: {
            ...process.env,
            PATH: directory + ':' + process.env.PATH,
            CALLS: join(directory, 'calls'),
            FAIL: failure,
          },
        },
      )
    try {
      expect((await execute('none')).stdout).toBe('receipt-only')
      for (const failure of ['prepare', 'before', 'restart', 'health', 'after'])
        await expect(execute(failure)).rejects.toThrow()
      const calls = await readFile(join(directory, 'calls'), 'utf8')
      expect(calls).not.toContain('synthetic-pipe-state')
      expect(calls).not.toContain('revoked-pipe-state')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('wires the real exchange, private authority peer, restart, and strict receipt', async () => {
    const scratchDirectory = await mkdtemp(
      join(tmpdir(), 'revocation-contract-'),
    )
    const assertions = suite.requiredAssertions.map((id) => ({
      id,
      status: 'passed' as const,
    }))
    let output = JSON.stringify({ suite: suite.id, assertions })
    const runCommand = vi.fn(async (file, args, cwd) => {
      const assets = join(scratchDirectory, 'standard-browser-assets')
      expect(file).toBe('bash')
      expect(args).toEqual([
        '-ec',
        probePipeline,
        suite.id,
        '/tmp/nerv/compose.yaml',
        'nerv',
        '/tmp/nerv',
        assets,
      ])
      expect(cwd).toBe('/tmp/nerv')
      for (const file of [
        'driver.mjs',
        'standard-credential-transport.driver.mjs',
        'credential-revocation-contract.driver.mjs',
      ]) {
        expect((await stat(join(assets, file))).mode & 0o777).toBe(0o644)
      }
      expect(
        await readFile(
          join(assets, 'standard-credential-transport.driver.mjs'),
          'utf8',
        ),
      ).toBe(
        await readFile(
          new URL(
            './standard-credential-transport.driver.mjs',
            import.meta.url,
          ),
          'utf8',
        ),
      )
      expect(
        await readFile(
          join(assets, 'credential-revocation-contract.driver.mjs'),
          'utf8',
        ),
      ).toBe(
        await readFile(
          new URL(
            './credential-revocation-contract.driver.mjs',
            import.meta.url,
          ),
          'utf8',
        ),
      )
      return output
    })
    const context = {
      scratchDirectory,
      composeFile: '/tmp/nerv/compose.yaml',
      projectName: 'nerv',
      sandboxDirectory: '/tmp/nerv',
      runCommand,
    }
    try {
      expect(await suite.run(context)).toEqual(assertions)
      expect(suite.id).toBe('credential-revocation-contract')
      expect(suite.requiredAssertions).toHaveLength(13)
      for (const assertion of assertions)
        expect(() =>
          validateAssertions(
            suite,
            assertions.filter((item) => item !== assertion),
          ),
        ).toThrow()
      output = JSON.stringify({ suite: 'credential-revocation', assertions })
      await expect(suite.run(context)).rejects.toThrow(
        'Unexpected revocation probe receipt',
      )
      for (const receipt of [
        { suite: 'credential-revocation', assertions },
        { suite: suite.id, assertions: [] },
        {
          suite: suite.id,
          assertions: [{ id: assertions[0].id, status: 'skipped' }],
        },
      ]) {
        output = JSON.stringify(receipt)
        await expect(suite.run(context)).rejects.toThrow()
      }
      output = 'not json'
      await expect(suite.run(context)).rejects.toThrow()
    } finally {
      await rm(scratchDirectory, { recursive: true, force: true })
    }
  })
})
