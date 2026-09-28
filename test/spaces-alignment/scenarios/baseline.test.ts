import { describe, expect, it } from 'vitest'
import { suite } from './baseline.js'
import { validateAssertions, validateSuite } from '../rules.js'

describe('baseline browser receipt', () => {
  it('requires separate PDS grant and unrelated-boundary evidence', () => {
    expect(suite.requiredAssertions).toContain('pds-space-grant')
    expect(suite.requiredAssertions).toContain('unrelated-boundary-denied')
  })

  it('runs the isolated browser service and accepts every required assertion', async () => {
    const assertions = suite.requiredAssertions.map((id) => ({
      id,
      status: 'passed' as const,
    }))
    const calls: Array<{ file: string; args: string[]; cwd: string }> = []
    const results = await suite.run({
      sandboxDirectory: '/tmp/faye-sandbox',
      projectName: 'faye-test',
      reportDirectory: '/tmp/faye-report',
      async runCommand(file, args, cwd) {
        calls.push({ file, args, cwd })
        return `Browser output\n  ${JSON.stringify({ suite: 'baseline', assertions })}\nBrowser finished\n`
      },
    })
    expect(calls).toEqual([
      {
        file: 'docker',
        cwd: '/tmp/faye-sandbox',
        args: [
          'compose',
          '--project-name',
          'faye-test',
          '--project-directory',
          '/tmp/faye-sandbox',
          'run',
          '--rm',
          '--no-deps',
          'feedgen-e2e-browser',
        ],
      },
    ])
    expect(() => validateAssertions(suite, results)).not.toThrow()
    expect(() => validateSuite(suite)).not.toThrow()
  })

  it('rejects missing and invalid browser receipts', async () => {
    const context = (output: string) => ({
      sandboxDirectory: '/tmp/faye-sandbox',
      projectName: 'faye-test',
      reportDirectory: '/tmp/faye-report',
      async runCommand() {
        return output
      },
    })
    await expect(suite.run(context('Health check passed'))).rejects.toThrow(
      'no baseline assertion receipt',
    )
    await expect(
      suite.run(context('{"suite":"baseline","assertions":[]}')),
    ).resolves.toEqual([])
    await expect(
      suite.run(context('{"suite":"wrong","assertions":[]}')),
    ).rejects.toThrow('no baseline assertion receipt')
    await expect(
      suite.run(
        context('{"suite":"baseline","assertions":{},"suite":"wrong"}'),
      ),
    ).rejects.toThrow('invalid baseline assertion receipt')
    await expect(
      suite.run(context('{"suite":"baseline","assertions":{}}')),
    ).rejects.toThrow('invalid baseline assertion receipt')
  })
})
