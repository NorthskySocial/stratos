import { describe, expect, it, vi } from 'vitest'
import { runNovemberCacheEvidence } from './november-cache.driver.js'
import type { ScenarioContext } from '../rules.js'

const testName =
  'store::migrations::tests::a_verified_sync_of_a_member_works_end_to_end_on_a_migrated_file_store'

function context(output: string): ScenarioContext {
  return {
    sandboxDirectory: '/sandbox',
    composeFile: '/sandbox/compose.yaml',
    projectName: 'sandbox',
    scratchDirectory: '/work',
    runCommand: vi.fn().mockResolvedValue(output),
  }
}

describe('November cache evidence', () => {
  it('runs the exact Rust test from the exported candidate and identifies the endpoint gap', async () => {
    const ctx = context(
      `test ${testName} ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured`,
    )
    expect(await runNovemberCacheEvidence(ctx)).toEqual({
      test: testName,
      endpointBacked: false,
    })
    expect(ctx.runCommand).toHaveBeenCalledWith(
      'cargo',
      [
        'test',
        '--locked',
        '-p',
        'stratos-feedgen-ng',
        '--lib',
        testName,
        '--',
        '--exact',
      ],
      '/work/stratos',
    )
  })

  it.each([
    'test result: ok. 0 passed; 0 failed; 0 ignored;',
    `test ${testName} ... ok\ntest result: ok. 2 passed; 0 failed; 0 ignored;`,
  ])('rejects incomplete test output', async (output) => {
    await expect(runNovemberCacheEvidence(context(output))).rejects.toThrow(
      'exactly one passing test',
    )
  })
})
