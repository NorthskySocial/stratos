import { describe, expect, it } from 'vitest'
import { validateAssertions, type ScenarioContext } from '../rules.js'
import { suite } from './service-admission.js'

function context(
  output: string,
  signingKey = 'a'.repeat(64),
  exitCode: number | null = 0,
): ScenarioContext {
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
      expect(args.slice(0, -3)).toEqual([
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
        'sh',
        '-c',
      ])
      expect(args.at(-3)).toContain('__service_admission_exit__=')
      expect(args.at(-2)).toBe('_')
      expect(args.at(-1)).toContain('await checkDenied(actor.did)')
      expect(args.at(-1)).toContain('zone.stratos.space.listRepos')
      expect(args.at(-1)).toContain(
        'await checkPullRecords(actor.did, general)',
      )
      expect(args.at(-1)).toContain('await checkForeignPullDenied(actor.did)')
      return exitCode === null
        ? output
        : `${output}\n  __service_admission_exit__=${exitCode}  \n`
    },
  }
}

describe('service admission sandbox scenario', () => {
  it('requires record-scope checks for both pull routes', () => {
    expect(suite.requiredAssertions).toContain('active-assigned-pull-records')
    expect(suite.requiredAssertions).toContain('foreign-boundary-pull-denied')
  })

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

  it('reports a bounded diagnostic without exposing the signing key', async () => {
    const signingKey = 'a'.repeat(64)
    const output = `AssertionError [ERR_ASSERTION]: ${signingKey}\nactual: 401,\nexpected: 200,\n at file:///app/stratos-service/[eval1]:76:10`
    await expect(suite.run(context(output, signingKey, 1))).rejects.toThrow(
      'AssertionError ERR_ASSERTION script line 76 actual 401 expected 200',
    )
    await expect(suite.run(context(output, signingKey, 1))).rejects.not.toThrow(
      signingKey,
    )
    await expect(
      suite.run(
        context('AssertionError\nactual: false\nexpected: true', signingKey, 1),
      ),
    ).rejects.toThrow('AssertionError actual false expected true')
    await expect(
      suite.run(context('SQLITE_BUSY: database is locked', signingKey, 1)),
    ).rejects.toThrow('UnknownError SQLITE_BUSY')
    try {
      await suite.run(
        context(
          `unrelated failure\nsecretactual: 401,\nactual: 401,exposed\nsecretexpected: 200,\nsecret expected: 200,\nexpected: 200,exposed`,
          signingKey,
          1,
        ),
      )
      expect.fail('The failed command was admitted')
    } catch (error) {
      expect((error as Error).message).toBe(
        'Service admission command failed: UnknownError',
      )
    }
    await expect(suite.run(context('', signingKey, null))).rejects.toThrow(
      'no exit marker',
    )
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
