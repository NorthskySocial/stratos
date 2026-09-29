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
      const browserAssertions = assertions.slice(0, 9)
      const authorityAssertions = assertions.slice(9)
      let calls = 0
      const result = await suite.run({
        sandboxDirectory: '/tmp/sandbox',
        projectName: 'lifetime-test',
        reportDirectory,
        async runCommand(file, args) {
          expect(file).toBe('docker')
          const service =
            calls++ === 0 ? 'feedgen-e2e-browser' : 'feedgen-e2e-stratos'
          const script =
            service === 'feedgen-e2e-browser' ? 'driver.mjs' : 'authority.mjs'
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
            service,
            `/scenario/${script}`,
          ])
          return service === 'feedgen-e2e-browser'
            ? ` Browser ready\n ${JSON.stringify({ suite: 'credential-lifetime', assertions: browserAssertions })} \n`
            : ` Authority ready\n ${JSON.stringify({ suite: 'credential-lifetime-authority', assertions: authorityAssertions })} \n`
        },
      })
      expect(calls).toBe(2)
      const driver = await readFile(
        join(reportDirectory, 'browser-assets/driver.mjs'),
        'utf8',
      )
      expect(driver).toContain("new URL('/oauth/revoke', authorityUrl).href")
      const assets = join(reportDirectory, 'browser-assets')
      expect((await readdir(assets)).sort()).toEqual([
        'auth-client.iife.js',
        'authority.mjs',
        'driver.mjs',
      ])
      expect((await stat(assets)).mode & 0o777).toBe(0o755)
      expect(
        (await stat(join(assets, 'auth-client.iife.js'))).mode & 0o777,
      ).toBe(0o644)
      expect((await stat(join(assets, 'driver.mjs'))).mode & 0o777).toBe(0o644)
      expect((await stat(join(assets, 'authority.mjs'))).mode & 0o777).toBe(
        0o644,
      )
      const authority = await readFile(join(assets, 'authority.mjs'), 'utf8')
      expect(authority).toContain('await openServiceSigningIdentity(')
      expect(authority).toContain('await symlink(')
      expect(authority).toContain('assert.equal(after.mtimeMs, before.mtimeMs)')
      expect(authority).not.toContain('stored.privateKey')
      expect(authority).not.toContain('readFile(')
      expect(authority).not.toContain('rotate(')
      expect(authority).toContain('await catalog.update(')
      expect(authority).toContain('await catalog.beginDeactivation(')
      expect(authority).toContain("passed.push('local-deactivation-denied')")
      expect(driver.indexOf("passed.push('member-removed')")).toBeLessThan(
        driver.indexOf("passed.push('foreign-credential-after-removal')"),
      )
      expect(() => validateSuite(suite)).not.toThrow()
      expect(() => validateAssertions(suite, result)).not.toThrow()
      await suite.run({
        sandboxDirectory: '/tmp/sandbox',
        projectName: 'lifetime-test',
        reportDirectory,
        async runCommand(_file, args) {
          return args.at(-1) === '/scenario/driver.mjs'
            ? JSON.stringify({
                suite: 'credential-lifetime',
                assertions: browserAssertions,
              })
            : JSON.stringify({
                suite: 'credential-lifetime-authority',
                assertions: authorityAssertions,
              })
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

  it('rejects missing and malformed authority receipts', async () => {
    const reportDirectory = await mkdtemp(
      join(tmpdir(), 'credential-lifetime-'),
    )
    try {
      const browserReceipt = JSON.stringify({
        suite: 'credential-lifetime',
        assertions: [],
      })
      for (const [output, message] of [
        ['Authority ended without a receipt', 'no assertion receipt'],
        [
          '{"suite":"credential-lifetime-authority","assertions":{}}',
          'invalid assertion receipt',
        ],
        [
          '{"suite":"credential-lifetime-authority","assertions":[],"suite":"wrong"}',
          'invalid assertion receipt',
        ],
      ]) {
        await expect(
          suite.run({
            sandboxDirectory: '/tmp/sandbox',
            projectName: 'lifetime-test',
            reportDirectory,
            async runCommand(_file, args) {
              return args.at(-1) === '/scenario/driver.mjs'
                ? browserReceipt
                : output
            },
          }),
        ).rejects.toThrow(message)
      }
    } finally {
      await rm(reportDirectory, { recursive: true, force: true })
    }
  })
})
