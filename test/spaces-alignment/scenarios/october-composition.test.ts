import { describe, expect, it, vi } from 'vitest'
import { suite } from './october-interop.js'
import { suite as rust } from './rust-production-interop.js'
import { suite as baseline } from './baseline.js'
import { suite as standard } from './standard-credential-transport.js'
import { suiteExecutionOrder, validateAssertions } from '../rules.js'

vi.mock('node:fs/promises', () => ({
  copyFile: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(async () => '      STRATOS_PORT: 3100\n'),
}))
vi.mock('./standard-credential-transport.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./standard-credential-transport.js')>()
  return {
    ...actual,
    prepareBrowserRunner: vi.fn(async () => '/private/report/assets'),
    suite: {
      ...actual.suite,
      run: vi.fn(async () =>
        actual.suite.requiredAssertions.map((id) => ({ id, status: 'passed' })),
      ),
    },
  }
})
const passed = (ids: readonly string[]) =>
  ids.map((id) => ({ id, status: 'passed' as const }))

describe('real October Rust composition', () => {
  it.each([suite, rust])(
    'runs one mandatory Motoko baseline and a distinct Batou ingestion for $id',
    async (selected) => {
      const commands: string[][] = []
      const input = {
        composeFile: '/private/compose.yaml',
        sandboxDirectory: '/private/sandbox',
        projectName: 'faye',
        reportDirectory: '/private/report',
        runCommand: vi.fn(async (_file: string, args: string[]) => {
          commands.push(args)
          if (args.includes('/scenario/rust-production-interop.driver.mjs'))
            return JSON.stringify({
              suite: rust.id,
              assertions: passed(rust.requiredAssertions.slice(1)),
            })
          if (args.includes('up')) return ''
          return JSON.stringify({
            suite: baseline.id,
            assertions: passed(baseline.requiredAssertions),
          })
        }),
      }
      const results = new Map()
      for (const scenario of suiteExecutionOrder(selected.id, [
        baseline,
        selected,
      ])) {
        const assertions = await scenario.run(input)
        validateAssertions(scenario, assertions)
        results.set(scenario.id, assertions)
      }
      expect(results.get(baseline.id)).toEqual(
        passed(baseline.requiredAssertions),
      )
      expect(results.get(baseline.id)).toHaveLength(10)
      expect(results.get(selected.id)).toEqual(
        passed(selected.requiredAssertions),
      )
      expect(selected.requiredAssertions).toHaveLength(
        selected === suite ? 26 : 11,
      )
      const ingestion = commands.filter((args) => args.includes('--build'))
      expect(ingestion).toHaveLength(2)
      const common = [
        'compose',
        '--file',
        input.composeFile,
        '--project-name',
        input.projectName,
        '--project-directory',
        input.sandboxDirectory,
        'run',
        '--build',
        '--rm',
        '--no-deps',
      ]
      expect(ingestion[0]).toEqual([...common, 'feedgen-e2e-browser'])
      expect(ingestion[1]).toEqual([
        ...common,
        '--env',
        'FEEDGEN_E2E_PDS_ACCOUNT=batou',
        'feedgen-e2e-browser',
      ])
      expect(
        commands.filter((args) =>
          args.includes('/scenario/rust-production-interop.driver.mjs'),
        ),
      ).toHaveLength(1)
      expect(commands).toHaveLength(selected === suite ? 4 : 3)
      if (selected === suite) expect(standard.run).toHaveBeenCalledWith(input)
    },
  )

  it('rejects a failed second-owner ingestion before invoking the real Rust probe', async () => {
    const runCommand = vi.fn(async () =>
      JSON.stringify({ suite: baseline.id, assertions: [] }),
    )
    await expect(
      suite.run({
        composeFile: '/private/compose.yaml',
        sandboxDirectory: '/private/sandbox',
        projectName: 'faye',
        reportDirectory: '/private/report',
        runCommand,
      }),
    ).rejects.toThrow()
    expect(runCommand).toHaveBeenCalledTimes(2)
    expect(runCommand.mock.calls[1]).toBeDefined()
  })
})
