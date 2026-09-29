import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateAssertions, validateSuite } from '../rules.js'
import { suite } from './credential-lifetime.js'

describe('credential lifetime sandbox scenario', () => {
  it('runs the real browser lifecycle and requires every receipt', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'credential-lifetime-'),
    )
    try {
      const assertions = suite.requiredAssertions.map((id) => ({
        id,
        status: 'passed' as const,
      }))
      const result = await suite.run({
        sandboxDirectory: '/tmp/sandbox',
        projectName: 'lifetime-test',
        reportDirectory,
        async runCommand(file, args) {
          expect(file).toBe('docker')
          expect(args).toEqual([
            'compose',
            '--project-name',
            'lifetime-test',
            '--project-directory',
            '/tmp/sandbox',
            'run',
            '--rm',
            '--no-deps',
            '--volume',
            `${join(reportDirectory, 'browser-assets')}:/scenario:ro,z`,
            '--entrypoint',
            'node',
            'feedgen-e2e-browser',
            '/scenario/driver.mjs',
          ])
          return ` Browser ready\n ${JSON.stringify({ suite: 'credential-lifetime', assertions })} \n`
        },
      })
      const driver = await readFile(
        join(reportDirectory, 'browser-assets/driver.mjs'),
        'utf8',
      )
      expect(driver).toContain("new URL('/oauth/revoke', authorityUrl).href")
      const assets = join(reportDirectory, 'browser-assets')
      expect((await readdir(assets)).sort()).toEqual([
        'auth-client.iife.js',
        'driver.mjs',
      ])
      expect((await stat(assets)).mode & 0o777).toBe(0o755)
      expect(
        (await stat(join(assets, 'auth-client.iife.js'))).mode & 0o777,
      ).toBe(0o644)
      expect((await stat(join(assets, 'driver.mjs'))).mode & 0o777).toBe(0o644)
      expect(driver.indexOf("passed.push('member-removed')")).toBeLessThan(
        driver.indexOf("passed.push('foreign-credential-after-removal')"),
      )
      expect(() => validateSuite(suite)).not.toThrow()
      expect(() => validateAssertions(suite, result)).not.toThrow()
      await suite.run({
        sandboxDirectory: '/tmp/sandbox',
        projectName: 'lifetime-test',
        reportDirectory,
        async runCommand() {
          return JSON.stringify({ suite: 'credential-lifetime', assertions })
        },
      })
    } finally {
      await rm(reportDirectory, { recursive: true, force: true })
    }
  })

  it('rejects missing and malformed browser receipts', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'credential-lifetime-'),
    )
    try {
      for (const [output, message] of [
        ['Browser ended without a receipt', 'no assertion receipt'],
        [
          '{"suite":"credential-lifetime","assertions":{}}',
          'invalid assertion receipt',
        ],
        [
          '{"suite":"credential-lifetime","assertions":[],"suite":"wrong"}',
          'invalid assertion receipt',
        ],
        ['{"suite":"wrong","assertions":[]}', 'no assertion receipt'],
      ]) {
        await expect(
          suite.run({
            sandboxDirectory: '/tmp/sandbox',
            projectName: 'lifetime-test',
            reportDirectory,
            async runCommand() {
              return output
            },
          }),
        ).rejects.toThrow(message)
      }
    } finally {
      await rm(reportDirectory, { recursive: true, force: true })
    }
  })
})
