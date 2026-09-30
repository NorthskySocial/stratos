import { describe, expect, it } from 'vitest'
import { validateAssertions, type ScenarioContext } from '../rules.js'
import { suite } from './pds-revocation.js'

function context(output: string): ScenarioContext {
  return {
    sandboxDirectory: '/tmp/private-sandbox',
    projectName: 'private-test',
    reportDirectory: '/tmp/private-report',
    runCommand: async (file, args, cwd) => {
      expect(file).toBe('node')
      expect(args[0]).toMatch(/pds-revocation\.mjs$/)
      expect(args.slice(1)).toEqual(['/tmp/private-sandbox', 'private-test'])
      expect(cwd).toBe('/tmp/private-sandbox')
      return output
    },
  }
}

describe('PDS revocation sandbox scenario', () => {
  it('accepts only a complete assertion receipt', async () => {
    const assertions = suite.requiredAssertions.map((id) => ({
      id,
      status: 'passed' as const,
    }))
    const actual = await suite.run(
      context(
        `noise\n  ${JSON.stringify({ suite: suite.id, assertions })}  \n`,
      ),
    )
    expect(actual).toEqual(assertions)
    expect(() => validateAssertions(suite, actual)).not.toThrow()
  })

  it('rejects missing and malformed receipts', async () => {
    await expect(suite.run(context('health ok'))).rejects.toThrow(
      'no assertion receipt',
    )
    await expect(
      suite.run(
        context('{"suite":"pds-revocation","assertions":[],"suite":"wrong"}'),
      ),
    ).rejects.toThrow('invalid assertion receipt')
    await expect(
      suite.run(context('{"suite":"pds-revocation","assertions":{}}')),
    ).rejects.toThrow('invalid assertion receipt')
    await expect(
      suite.run(context('{"suite":"pds-revocation","assertions":[]}')),
    ).resolves.toEqual([])
  })
})
