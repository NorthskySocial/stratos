import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { suite } from './client-custody.js'

describe('client custody sandbox suite', () => {
  it('bundles the actual SDK and invokes the private browser container', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'client-custody-scenario-'))
    const assertions = suite.requiredAssertions.map((id) => ({
      id,
      status: 'passed',
    }))
    const runCommand = vi.fn(
      async (file: string, args: string[], cwd: string) => {
        expect(file).toBe('docker')
        expect(cwd).toBe(directory)
        expect(args).toEqual([
          'compose',
          '--project-name',
          'stratos-test',
          '--project-directory',
          directory,
          'run',
          '--rm',
          '--no-deps',
          '--entrypoint',
          'node',
          '--volume',
          `${join(directory, 'client-custody-sdk.mjs')}:/runner/client-custody-sdk.mjs:ro`,
          '--volume',
          `${fileURLToPath(new URL('./client-custody.mjs', import.meta.url))}:/runner/client-custody.mjs:ro`,
          'feedgen-e2e-browser',
          '/runner/client-custody.mjs',
        ])
        return `Container ready\n  ${JSON.stringify({ suite: 'client-custody', assertions })}\n`
      },
    )
    try {
      const results = await suite.run({
        sandboxDirectory: directory,
        reportDirectory: directory,
        projectName: 'stratos-test',
        runCommand,
      })
      expect(results).toEqual(assertions)
      expect(
        await readFile(join(directory, 'client-custody-sdk.mjs'), 'utf8'),
      ).toContain('resolveRepositoryTarget')
      const sdk = await import(
        pathToFileURL(join(directory, 'client-custody-sdk.mjs')).href
      )
      expect(typeof sdk.resolveRepositoryTarget).toBe('function')
      expect(suite.id).toBe('client-custody')
      expect(runCommand).toHaveBeenCalledOnce()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    [
      'missing receipt',
      'no receipt',
      'Client custody runner returned no assertion receipt',
    ],
    [
      'wrong suite',
      '{"suite":"client-custody","assertions":[],"suite":"other"}',
      'Client custody runner returned an invalid assertion receipt',
    ],
    [
      'invalid assertions',
      JSON.stringify({ suite: 'client-custody', assertions: {} }),
      'Client custody runner returned an invalid assertion receipt',
    ],
  ])('rejects %s', async (_name, output, expectedError) => {
    const directory = await mkdtemp(join(tmpdir(), 'client-custody-scenario-'))
    try {
      await expect(
        suite.run({
          sandboxDirectory: directory,
          reportDirectory: directory,
          projectName: 'stratos-test',
          runCommand: async () => output,
        }),
      ).rejects.toThrow(expectedError)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
