import { describe, expect, it, vi } from 'vitest'
import { suite } from './staging-limits.js'

describe('staging limits sandbox receipt', () => {
  it('requires the private scenario to return its structured assertions', async () => {
    expect(suite.id).toBe('staging-limits')
    expect(suite.requiredAssertions).toEqual([
      'cumulative-pass-budget',
      'same-path-replacement-and-delete-accounting',
      'rejected-page-transaction-rollback',
      'promotion-replaces-staged-accounting',
      'unrelated-target-remains-available',
      'multi-target-global-budget',
      'storage-accounting',
      'service-responsive',
      'interrupted-stage',
      'expired-stage-restart',
    ])
    const assertions = suite.requiredAssertions.map((id) => ({
      id,
      status: 'passed' as const,
    }))
    const runCommand = vi
      .fn()
      .mockResolvedValue(
        `diagnostic output\n  ${JSON.stringify({ suite: 'staging-limits', assertions })}\n`,
      )
    const results = await suite.run({
      sandboxDirectory: '/tmp/disposable-sandbox',
      projectName: 'disposable',
      reportDirectory: '/tmp/disposable-report',
      runCommand,
    })
    expect(results).toEqual(assertions)
    expect(runCommand).toHaveBeenCalledWith(
      'node',
      [
        expect.stringContaining('staging-limits.mjs'),
        '/tmp/disposable-sandbox',
        'disposable',
      ],
      '/tmp/disposable-sandbox',
    )
  })

  it('rejects a missing or malformed scenario receipt', async () => {
    for (const [output, error] of [
      ['', 'Staging limits returned no assertion receipt'],
      [
        '{"suite":"other","assertions":[]}',
        'Staging limits returned no assertion receipt',
      ],
      [
        '{"suite":"staging-limits","assertions":null}',
        'Staging limits returned an invalid assertion receipt',
      ],
      [
        '{"suite":"staging-limits","assertions":[],"suite":"other"}',
        'Staging limits returned an invalid assertion receipt',
      ],
    ] as const) {
      await expect(
        suite.run({
          sandboxDirectory: '/tmp/disposable-sandbox',
          projectName: 'disposable',
          reportDirectory: '/tmp/disposable-report',
          runCommand: vi.fn().mockResolvedValue(output),
        }),
      ).rejects.toThrow(error)
    }
  })
})
