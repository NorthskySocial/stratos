import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as filesystem from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { validateAssertions } from '../rules.js'
import { suite } from './standard-credential-transport.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, chmod: vi.fn(original.chmod) }
})

describe('standard credential transport', () => {
  it('waits for both asset permissions before invoking Docker', async () => {
    const scratchDirectory = await mkdtemp(
      join(tmpdir(), 'standard-permissions-'),
    )
    const original =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      )
    const releases: (() => void)[] = []
    const chmod = vi.mocked(filesystem.chmod)
    chmod.mockImplementation(async (file, mode) => {
      if (mode === 0o644)
        await new Promise<void>((resolve) => releases.push(resolve))
      await original.chmod(file, mode)
    })
    const runCommand = vi.fn(async () => '')
    const running = suite.run({
      sandboxDirectory: '/tmp/faye',
      composeFile: '/tmp/faye/compose.yaml',
      projectName: 'faye',
      scratchDirectory,
      runCommand,
    })
    const result = running.catch((error: unknown) => error)
    try {
      await vi.waitFor(() => expect(releases).toHaveLength(2), {
        timeout: 10_000,
      })
      expect(runCommand).not.toHaveBeenCalled()
      releases[0]()
      await new Promise((resolve) => setImmediate(resolve))
      expect(runCommand).not.toHaveBeenCalled()
      releases[1]()
      expect(await result).toEqual(
        expect.objectContaining({
          message: 'Delegation browser returned no assertion receipt',
        }),
      )
      expect(runCommand).toHaveBeenCalledTimes(1)
    } finally {
      for (const release of releases) release()
      await result
      chmod.mockImplementation(original.chmod)
      await rm(scratchDirectory, { recursive: true, force: true })
    }
  })
  it('runs the real driver and rejects absent or incomplete receipts', async () => {
    const scratchDirectory = await mkdtemp(
      join(tmpdir(), 'standard-transport-'),
    )
    try {
      let output = ''
      const context = {
        sandboxDirectory: '/tmp/faye',
        composeFile: '/tmp/faye/compose.yaml',
        projectName: 'faye',
        scratchDirectory,
        async runCommand(file: string, args: string[]) {
          expect(file).toBe('docker')
          const assets = join(scratchDirectory, 'standard-browser-assets')
          expect(args).toEqual([
            'compose',
            '--file',
            '/tmp/faye/compose.yaml',
            '--project-name',
            'faye',
            '--project-directory',
            '/tmp/faye',
            'run',
            '--rm',
            '--no-deps',
            '--volume',
            `${assets}:/scenario:ro,z`,
            '--entrypoint',
            'node',
            'feedgen-e2e-browser',
            '/scenario/driver.mjs',
          ])
          expect((await stat(assets)).mode & 0o777).toBe(0o755)
          for (const file of ['auth-client.iife.js', 'driver.mjs'])
            expect((await stat(join(assets, file))).mode & 0o777).toBe(0o644)
          expect(await readFile(join(assets, 'driver.mjs'), 'utf8')).toBe(
            await readFile(
              new URL(
                './standard-credential-transport.driver.mjs',
                import.meta.url,
              ),
              'utf8',
            ),
          )
          return output
        },
      }
      await writeFile(join(scratchDirectory, 'sentinel'), 'retained')
      await expect(suite.run(context)).rejects.toThrow('no assertion receipt')
      expect(await readFile(join(scratchDirectory, 'sentinel'), 'utf8')).toBe(
        'retained',
      )
      output =
        '{"suite":"standard-credential-transport","assertions":[],"suite":"other"}'
      await expect(suite.run(context)).rejects.toThrow(
        'invalid assertion receipt',
      )
      output = JSON.stringify({ suite: suite.id, assertions: null })
      await expect(suite.run(context)).rejects.toThrow(
        'invalid assertion receipt',
      )
      output = JSON.stringify({ suite: suite.id, assertions: [] })
      expect(() => validateAssertions(suite, [])).toThrow()
      const assertions = suite.requiredAssertions.map((id) => ({
        id,
        status: 'passed' as const,
      }))
      output =
        'noise\n  ' + JSON.stringify({ suite: suite.id, assertions }) + '  \n'
      expect(await suite.run(context)).toEqual(assertions)
      for (const omitted of assertions) {
        expect(() =>
          validateAssertions(
            suite,
            assertions.filter((item) => item !== omitted),
          ),
        ).toThrow()
      }
      validateAssertions(suite, assertions)
    } finally {
      await rm(scratchDirectory, { recursive: true, force: true })
    }
  })
})
