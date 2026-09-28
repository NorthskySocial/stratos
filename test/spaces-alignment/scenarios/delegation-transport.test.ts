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
      const calls: string[][] = []
      const results = await suite.run({
        sandboxDirectory: '/tmp/delegation-sandbox',
        projectName: 'delegation-test',
        reportDirectory,
        async runCommand(file, args) {
          expect(file).toBe('docker')
          calls.push(args)
          return `Browser ready\n ${JSON.stringify({ suite: 'delegation-transport', assertions })}\n`
        },
      })
      expect(calls).toHaveLength(1)
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
        `${reportDirectory}:/scenario:ro`,
        '--entrypoint',
        'node',
        'feedgen-e2e-browser',
        '/scenario/driver.mjs',
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
})
