import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateAssertions, validateSuite } from '../rules.js'
import { suite } from './delegation-transport.js'

describe('delegation transport browser scenario', () => {
  it('bundles the public OAuth client and requires a PDS-issued delegation receipt', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'delegation-scenario-'),
    )
    try {
      await writeFile(join(reportDirectory, 'keep'), 'sentinel')
      const assertions = suite.requiredAssertions.map((id) => ({
        id,
        status: 'passed' as const,
      }))
      const browserAssertions = assertions.filter(
        ({ id }) => id !== 'ordinary-bearer-denied',
      )
      const calls: string[][] = []
      const results = await suite.run({
        sandboxDirectory: '/tmp/delegation-sandbox',
        projectName: 'delegation-test',
        reportDirectory,
        async runCommand(file, args) {
          expect(file).toBe('docker')
          calls.push(args)
          if (args.includes('feedgen-e2e-browser')) {
            return `Browser ready\n ${JSON.stringify({ suite: 'delegation-transport', assertions: browserAssertions })}\n`
          }
          if (args.includes('feedgen-e2e-rust')) return `${'a'.repeat(64)}\n`
          expect(args).toEqual([
            'compose',
            '--project-name',
            'delegation-test',
            '--project-directory',
            '/tmp/delegation-sandbox',
            'exec',
            '-T',
            '-e',
            `DELEGATION_SIGNING_KEY=${'a'.repeat(64)}`,
            'feedgen-e2e-stratos',
            'sh',
            '-c',
            expect.stringContaining('__delegation_service_bearer_exit__='),
            '_',
            expect.stringContaining('createServiceJwt'),
          ])
          return `  ${JSON.stringify({ suite: 'delegation-service-bearer', assertions: [assertions.at(-1)] })}  \n  __delegation_service_bearer_exit__=0  \n`
        },
      })
      expect(calls).toHaveLength(3)
      expect(calls[0]).toEqual([
        'compose',
        '--project-name',
        'delegation-test',
        '--project-directory',
        '/tmp/delegation-sandbox',
        'run',
        '--rm',
        '--no-deps',
        '--volume',
        `${reportDirectory}:/scenario:ro,Z`,
        '--entrypoint',
        'node',
        'feedgen-e2e-browser',
        '/scenario/driver.mjs',
      ])
      expect(calls[1]).toEqual([
        'compose',
        '--project-name',
        'delegation-test',
        '--project-directory',
        '/tmp/delegation-sandbox',
        'exec',
        '-T',
        'feedgen-e2e-rust',
        'cat',
        '/tmp/feedgen-signing-key',
      ])
      expect(await readFile(join(reportDirectory, 'keep'), 'utf8')).toBe(
        'sentinel',
      )
      expect(
        await readFile(join(reportDirectory, 'auth-client.iife.js'), 'utf8'),
      ).toContain('delegationScenarioAuth')
      expect(
        await readFile(join(reportDirectory, 'driver.mjs'), 'utf8'),
      ).toContain('getDelegationToken')
      expect(suite.requiredAssertions).toContain('pds-issued-delegation')
      expect(suite.requiredAssertions).toContain('foreign-repo-read')
      expect(() => validateSuite(suite)).not.toThrow()
      expect(() => validateAssertions(suite, results)).not.toThrow()
    } finally {
      await rm(reportDirectory, { recursive: true, force: true })
    }
  })

  it('rejects a browser run with no receipt', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'delegation-scenario-'),
    )
    try {
      await expect(
        suite.run({
          sandboxDirectory: '/tmp/delegation-sandbox',
          projectName: 'delegation-test',
          reportDirectory,
          async runCommand() {
            return 'Browser exited without a receipt'
          },
        }),
      ).rejects.toThrow('no assertion receipt')
    } finally {
      await rm(reportDirectory, { recursive: true, force: true })
    }
  })

  it('rejects malformed browser receipts', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'delegation-scenario-'),
    )
    try {
      for (const receipt of [
        '{"suite":"delegation-transport","assertions":{}}',
        '{"suite":"delegation-transport","assertions":[],"suite":"wrong"}',
      ]) {
        await expect(
          suite.run({
            sandboxDirectory: '/tmp/delegation-sandbox',
            projectName: 'delegation-test',
            reportDirectory,
            async runCommand() {
              return receipt
            },
          }),
        ).rejects.toThrow('invalid assertion receipt')
      }
    } finally {
      await rm(reportDirectory, { recursive: true, force: true })
    }
  })

  it('rejects failed service-token checks without revealing the sandbox key', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'delegation-scenario-'),
    )
    const signingKey = 'a'.repeat(64)
    try {
      const runWithServiceOutput = (serviceOutput: string, key = signingKey) =>
        suite.run({
          sandboxDirectory: '/tmp/delegation-sandbox',
          projectName: 'delegation-test',
          reportDirectory,
          async runCommand(_file, args) {
            if (args.includes('feedgen-e2e-browser')) {
              return JSON.stringify({
                suite: 'delegation-transport',
                assertions: [{ id: 'header-exchange', status: 'passed' }],
              })
            }
            if (args.includes('feedgen-e2e-rust')) return key
            return serviceOutput
          },
        })
      await expect(
        runWithServiceOutput(
          `AssertionError: ${signingKey}\n__delegation_service_bearer_exit__=1`,
        ),
      ).rejects.toThrow('Service Bearer check failed: AssertionError')
      await expect(
        runWithServiceOutput(
          `AssertionError: ${signingKey}\n__delegation_service_bearer_exit__=1`,
        ),
      ).rejects.not.toThrow(signingKey)
      await expect(
        runWithServiceOutput('__delegation_service_bearer_exit__=0'),
      ).rejects.toThrow('no assertion receipt')
      await expect(
        runWithServiceOutput('__delegation_service_bearer_exit__=1'),
      ).rejects.toThrow('Service Bearer check failed: UnknownError')
      for (const key of ['bad-key', `x${signingKey}`, `${signingKey}x`]) {
        await expect(runWithServiceOutput('', key)).rejects.toThrow(
          'Sandbox feedgen signing key was unavailable',
        )
      }
      for (const receipt of [
        '{"suite":"delegation-service-bearer","assertions":[{"id":"ordinary-bearer-denied","status":"passed"}],"suite":"wrong"}',
        { suite: 'delegation-service-bearer', assertions: {} },
        { suite: 'delegation-service-bearer', assertions: [] },
        {
          suite: 'delegation-service-bearer',
          assertions: [{ id: 'wrong', status: 'passed' }],
        },
        {
          suite: 'delegation-service-bearer',
          assertions: [{ id: 'ordinary-bearer-denied', status: 'failed' }],
        },
        {
          suite: 'delegation-service-bearer',
          assertions: [
            { id: 'ordinary-bearer-denied', status: 'passed' },
            { id: 'extra', status: 'passed' },
          ],
        },
      ]) {
        await expect(
          runWithServiceOutput(
            `${typeof receipt === 'string' ? receipt : JSON.stringify(receipt)}\n__delegation_service_bearer_exit__=0`,
          ),
        ).rejects.toThrow('invalid assertion receipt')
      }
    } finally {
      await rm(reportDirectory, { recursive: true, force: true })
    }
  }, 30_000)
})
