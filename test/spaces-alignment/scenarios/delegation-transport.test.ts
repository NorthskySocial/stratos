import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
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
          expect(args).toEqual([
            'compose',
            '--project-name',
            'delegation-test',
            '--project-directory',
            '/tmp/delegation-sandbox',
            'run',
            '--rm',
            '--no-deps',
            '--entrypoint',
            'deno',
            'feedgen-e2e-identity',
            'eval',
            '--cached-only',
            '--allow-env=SANDBOX_DOMAIN',
            '--allow-read=/run/sandbox-secrets/feedgen-signing-key',
            '--allow-net=feedgen-e2e-stratos:3100',
            expect.stringContaining('Secp256k1Keypair.import(signingKey)'),
          ])
          expect(args.at(-1)).toContain("'zone.stratos.space.listRepos'")
          expect(args.at(-1)).toContain(
            'requireEqual(admittedResponse.status, 200)',
          )
          expect(args.at(-1)).toContain(
            "'zone.stratos.space.getSpaceCredential'",
          )
          expect(args.at(-1)).toContain(
            "requireEqual(body.error, 'InvalidToken')",
          )
          expect(args.at(-1)).not.toContain('DELEGATION_SIGNING_KEY')
          expect(
            args.filter((arg) => arg.includes('feedgen-signing-key')),
          ).toEqual([
            '--allow-read=/run/sandbox-secrets/feedgen-signing-key',
            expect.stringContaining(
              "Deno.readTextFile('/run/sandbox-secrets/feedgen-signing-key')",
            ),
          ])
          return `  ${JSON.stringify({ suite: 'delegation-service-bearer', assertions: [assertions.at(-1)] })}  \n`
        },
      })
      expect(calls).toHaveLength(2)
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
        `${join(reportDirectory, 'browser-assets')}:/scenario:ro,Z`,
        '--entrypoint',
        'node',
        'feedgen-e2e-browser',
        '/scenario/driver.mjs',
      ])
      expect(await readFile(join(reportDirectory, 'keep'), 'utf8')).toBe(
        'sentinel',
      )
      const browserAssets = join(reportDirectory, 'browser-assets')
      expect((await stat(reportDirectory)).mode & 0o777).toBe(0o700)
      expect((await stat(browserAssets)).mode & 0o777).toBe(0o755)
      expect((await readdir(browserAssets)).sort()).toEqual([
        'auth-client.iife.js',
        'driver.mjs',
      ])
      expect(
        (await stat(join(browserAssets, 'auth-client.iife.js'))).mode & 0o777,
      ).toBe(0o644)
      expect((await stat(join(browserAssets, 'driver.mjs'))).mode & 0o777).toBe(
        0o644,
      )
      expect(
        await readFile(join(browserAssets, 'auth-client.iife.js'), 'utf8'),
      ).toContain('delegationScenarioAuth')
      expect(
        await readFile(join(browserAssets, 'driver.mjs'), 'utf8'),
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

  it('rejects invalid service-token receipts without revealing a token', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'delegation-scenario-'),
    )
    const privateToken = 'signed.service.jwt'
    try {
      const runWithServiceOutput = (serviceOutput: string) =>
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
            return serviceOutput
          },
        })
      await expect(
        runWithServiceOutput(`AssertionError: ${privateToken}`),
      ).rejects.not.toThrow(privateToken)
      await expect(runWithServiceOutput('')).rejects.toThrow(
        'no assertion receipt',
      )
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
            `${typeof receipt === 'string' ? receipt : JSON.stringify(receipt)}\n`,
          ),
        ).rejects.toThrow('invalid assertion receipt')
      }
    } finally {
      await rm(reportDirectory, { recursive: true, force: true })
    }
  }, 30_000)
})
