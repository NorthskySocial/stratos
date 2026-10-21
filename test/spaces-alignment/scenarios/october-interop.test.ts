import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { suite } from './october-interop.js'
import { suite as standard } from './standard-credential-transport.js'
import {
  suite as rust,
  runSecondOwnerIngestion,
  runRustProbe,
} from './rust-production-interop.js'
import { suite as baseline } from './baseline.js'
import { suiteExecutionOrder, validateAssertions } from '../rules.js'

vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), writeFile: vi.fn() }))
vi.mock('./standard-credential-transport.js', () => ({
  suite: {
    id: 'standard',
    requiredAssertions: Array.from({ length: 15 }, (_, i) => `standard-${i}`),
    run: vi.fn(),
  },
}))
vi.mock('./rust-production-interop.js', () => ({
  runSecondOwnerIngestion: vi.fn(),
  runRustProbe: vi.fn(),
  suite: {
    id: 'rust',
    requiredAssertions: Array.from({ length: 11 }, (_, i) => `rust-${i}`),
    run: vi.fn(),
  },
}))
const context = () => ({
  composeFile: '/private/compose.yaml',
  sandboxDirectory: '/private/sandbox',
  projectName: 'faye',
  scratchDirectory: '/private/report',
  runCommand: vi.fn(async () => ''),
})
const results = (selected: typeof suite) =>
  selected.requiredAssertions.map((id) => ({ id, status: 'passed' as const }))
afterEach(() => vi.resetAllMocks())
function setup() {
  vi.mocked(standard.run).mockResolvedValue(results(standard))
  vi.mocked(runSecondOwnerIngestion).mockResolvedValue(
    results(rust).slice(0, 1),
  )
  vi.mocked(runRustProbe).mockResolvedValue(results(rust).slice(1))
  vi.mocked(readFile).mockResolvedValue(
    'services:\n  authority:\n    environment:\n      STRATOS_PORT: "3100"\n',
  )
}
describe('combined October interoperability', () => {
  it('requires baseline first and all 26 transport assertions without replacing either suite', async () => {
    setup()
    expect(suiteExecutionOrder(suite.id, [baseline, suite])).toEqual([
      baseline,
      suite,
    ])
    expect(suite.requiredAssertions).toEqual([
      ...standard.requiredAssertions,
      ...rust.requiredAssertions,
    ])
    expect(suite.requiredAssertions).toHaveLength(26)
    const input = context()
    const actual = await suite.run(input)
    validateAssertions(suite, actual)
    expect(actual).toEqual([...results(standard), ...results(rust)])
    expect(standard.run).toHaveBeenCalledWith(input)
    expect(runSecondOwnerIngestion).toHaveBeenCalledWith(input)
    expect(runRustProbe).toHaveBeenCalledWith(input)
    expect(rust.run).not.toHaveBeenCalled()
    expect(writeFile).toHaveBeenCalledWith(
      input.composeFile,
      'services:\n  authority:\n    environment:\n      STRATOS_SPACE_HTTP_CREDENTIAL_TTL_SECONDS: \'10\'\n      STRATOS_PORT: "3100"\n',
    )
    expect(input.runCommand).toHaveBeenCalledWith(
      'docker',
      [
        'compose',
        '--file',
        input.composeFile,
        '--project-name',
        input.projectName,
        '--project-directory',
        input.sandboxDirectory,
        'up',
        '--detach',
        '--no-deps',
        '--force-recreate',
        '--wait',
        'feedgen-e2e-stratos',
      ],
      input.sandboxDirectory,
    )
    expect(vi.mocked(standard.run).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(writeFile).mock.invocationCallOrder[0],
    )
    expect(input.runCommand.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runSecondOwnerIngestion).mock.invocationCallOrder[0],
    )
  })
  it.each(['standard', 'rust'])(
    'rejects every absent, skipped, failed and duplicate %s assertion',
    async (name) => {
      const selected = name === 'standard' ? standard : rust
      for (const id of selected.requiredAssertions) {
        for (const failure of [
          'absent',
          'skipped',
          'failed',
          'duplicate',
        ] as const) {
          setup()
          const altered = results(selected).filter(
            (item) => failure !== 'absent' || item.id !== id,
          )
          if (failure === 'duplicate')
            altered.push(altered.find((item) => item.id === id)!)
          if (failure === 'failed' || failure === 'skipped')
            Object.assign(altered.find((item) => item.id === id)!, {
              status: failure,
            })
          if (name === 'standard')
            vi.mocked(standard.run).mockResolvedValueOnce(altered)
          else {
            vi.mocked(runSecondOwnerIngestion).mockResolvedValueOnce([])
            vi.mocked(runRustProbe).mockResolvedValueOnce(altered)
          }
          await expect(suite.run(context())).rejects.toThrow()
        }
      }
    },
  )
  it('reads Compose as text and accepts an unquoted generated port', async () => {
    setup()
    vi.mocked(readFile).mockResolvedValue('      STRATOS_PORT: 3100\n')
    const input = context()
    await suite.run(input)
    expect(readFile).toHaveBeenCalledWith(input.composeFile, 'utf8')
    expect(writeFile).toHaveBeenCalledWith(
      input.composeFile,
      "      STRATOS_SPACE_HTTP_CREDENTIAL_TTL_SECONDS: '10'\n      STRATOS_PORT: 3100\n",
    )
  })
  it.each([
    'no port',
    '      STRATOS_PORT: 31001',
    "STRATOS_PORT: '3100'\nSTRATOS_SPACE_HTTP_CREDENTIAL_TTL_SECONDS: '10'",
  ])('rejects unexpected lifetime configuration %s', async (compose) => {
    setup()
    vi.mocked(readFile).mockResolvedValue(compose)
    await expect(suite.run(context())).rejects.toThrow(
      'Combined suite requires the default standard credential lifetime',
    )
    expect(rust.run).not.toHaveBeenCalled()
  })
  it('does not run Rust when the receiver restart fails', async () => {
    setup()
    const input = context()
    input.runCommand.mockRejectedValueOnce(new Error('restart failed'))
    await expect(suite.run(input)).rejects.toThrow('restart failed')
    expect(rust.run).not.toHaveBeenCalled()
  })
})
