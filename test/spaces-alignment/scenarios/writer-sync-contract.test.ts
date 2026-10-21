import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { suite } from './writer-sync-contract.js'

it('runs the real driver with explicit Compose identity and validates every receipt assertion', async () => {
  const scratchDirectory = await mkdtemp(join(tmpdir(), 'writer-contract-'))
  const assertions = suite.requiredAssertions.map((id) => ({
    id,
    status: 'passed' as const,
  }))
  let output = JSON.stringify({ suite: suite.id, assertions })
  const context = {
    scratchDirectory,
    composeFile: '/tmp/nerv/compose.yaml',
    projectName: 'nerv',
    sandboxDirectory: '/tmp/nerv',
    runCommand: vi.fn(async (file, args, cwd) => {
      const assets = join(scratchDirectory, 'standard-browser-assets')
      expect(file).toBe('docker')
      expect(args).toEqual([
        'compose',
        '--file',
        context.composeFile,
        '--project-name',
        'nerv',
        '--project-directory',
        '/tmp/nerv',
        'run',
        '--rm',
        '--no-deps',
        '--volume',
        `${assets}:/scenario:ro,z`,
        '--entrypoint',
        'node',
        'feedgen-e2e-browser',
        '/scenario/writer-sync-contract.driver.mjs',
      ])
      expect(cwd).toBe('/tmp/nerv')
      for (const name of [
        'writer-sync-contract.driver.mjs',
        'standard-credential-transport.driver.mjs',
      ]) {
        expect((await stat(join(assets, name))).mode & 0o777).toBe(0o644)
        expect(await readFile(join(assets, name), 'utf8')).toBe(
          await readFile(new URL('./' + name, import.meta.url), 'utf8'),
        )
      }
      return output
    }),
  }
  try {
    expect(suite.id).toBe('writer-sync-contract')
    expect(await suite.run(context)).toEqual(assertions)
    for (const receipt of [
      { suite: 'wrong', assertions },
      { suite: suite.id, assertions: [] },
      ...assertions.map((item) => ({
        suite: suite.id,
        assertions: assertions.filter((entry) => entry !== item),
      })),
      { suite: suite.id, assertions: [...assertions, assertions[0]] },
      {
        suite: suite.id,
        assertions: assertions.map((item) => ({ ...item, status: 'skipped' })),
      },
    ]) {
      output = JSON.stringify(receipt)
      await expect(suite.run(context)).rejects.toThrow()
    }
    output = JSON.stringify({ suite: 'wrong', assertions })
    await expect(suite.run(context)).rejects.toThrow(
      'Unexpected writer-sync receipt',
    )
    output = 'invalid-json'
    await expect(suite.run(context)).rejects.toThrow()
    context.runCommand.mockRejectedValueOnce(new Error('child failed'))
    await expect(suite.run(context)).rejects.toThrow('child failed')
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true })
  }
})
