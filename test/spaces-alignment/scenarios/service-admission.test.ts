import { describe, expect, it } from 'vitest'
import { validateAssertions, type ScenarioContext } from '../rules.js'
import { suite } from './service-admission.js'

function context(output: string, signingKey = 'a'.repeat(64)): ScenarioContext {
  return {
    sandboxDirectory: '/tmp/private-sandbox',
    projectName: 'stratos-private-test',
    reportDirectory: '/tmp/private-report',
    runCommand: async (file, args, cwd) => {
      expect(file).toBe('docker')
      expect(cwd).toBe('/tmp/private-sandbox')
      if (args.includes('feedgen-e2e-rust')) {
        expect(args).toEqual([
          'compose',
          '--project-name',
          'stratos-private-test',
          '--project-directory',
          '/tmp/private-sandbox',
          'exec',
          '-T',
          'feedgen-e2e-rust',
          'cat',
          '/tmp/feedgen-signing-key',
        ])
        return `${signingKey}\n`
      }
      expect(args.slice(0, -1)).toEqual([
        'compose',
        '--project-name',
        'stratos-private-test',
        '--project-directory',
        '/tmp/private-sandbox',
        'exec',
        '-T',
        '-e',
        `ADMISSION_SIGNING_KEY=${signingKey}`,
        'feedgen-e2e-stratos',
        'node',
        '--input-type=module',
        '-e',
      ])
      expect(args.at(-1)).toContain('await checkDenied(actor.did)')
      expect(args.at(-1)).toContain('zone.stratos.space.listRepos')
      return output
    },
  }
}

describe('service admission sandbox scenario', () => {
  it('accepts the complete real-command assertion receipt', async () => {
    const assertions = suite.requiredAssertions.map((id) => ({
      id,
      status: 'passed' as const,
    }))
    const output = `Docker output\n  ${JSON.stringify({ suite: suite.id, assertions })}  \n`
    const actual = await suite.run(context(output))
    expect(actual).toEqual(assertions)
    expect(() => validateAssertions(suite, actual)).not.toThrow()
  })

  it('rejects missing and malformed command receipts', async () => {
    await expect(suite.run(context('Docker output'))).rejects.toThrow(
      'no assertion receipt',
    )
    await expect(
      suite.run(context('{"suite":"service-admission","assertions":{}}')),
    ).rejects.toThrow('invalid assertion receipt')
    await expect(
      suite.run(context('{"suite":"service-admission","assertions":[]}')),
    ).resolves.toEqual([])
    await expect(
      suite.run(
        context(
          '{"suite":"service-admission","assertions":[],"suite":"wrong"}',
        ),
      ),
    ).rejects.toThrow('invalid assertion receipt')
  })

  it('rejects missing or malformed signing keys before making requests', async () => {
    for (const key of [
      '',
      'a'.repeat(63),
      `z${'a'.repeat(64)}`,
      `${'a'.repeat(64)}z`,
    ]) {
      await expect(suite.run(context('', key))).rejects.toThrow(
        'Sandbox signing key was unavailable',
      )
    }
  })
})
