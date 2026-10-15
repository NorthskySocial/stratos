import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateSuite } from '../rules.js'
import { suite } from './request-proof-foundation.js'

const evidenceRoot = new URL('../../../node_modules/', import.meta.url)

describe('synthetic request-proof foundation suite', () => {
  it.each([
    'valid',
    'missing',
    'failed',
    'duplicate',
    'incomplete',
    'extra',
    'malformed',
  ])(
    'checks the %s receipt without claiming production route coverage',
    async (kind) => {
      const directory = await mkdtemp(
        new URL('foundation-suite-', evidenceRoot).pathname,
      )
      try {
        const assertions = suite.requiredAssertions.map((id) => ({
          id,
          status: 'passed',
        }))
        if (kind === 'failed') assertions[0].status = 'failed'
        if (kind === 'duplicate') assertions.push(assertions[0])
        if (kind === 'incomplete') assertions.pop()
        if (kind === 'extra')
          assertions.push({ id: 'unexpected', status: 'passed' })
        const run = suite.run({
          sandboxDirectory: '/sandbox',
          composeFile: '/sandbox/compose.yaml',
          projectName: 'foundation-test',
          reportDirectory: directory,
          async runCommand(file, args, cwd) {
            expect(file).toBe('docker')
            expect(cwd).toBe('/sandbox')
            expect(args).toEqual([
              'compose',
              '--project-name',
              'foundation-test',
              '--project-directory',
              '/sandbox',
              'run',
              '--rm',
              '--no-deps',
              '--volume',
              `${join(directory, 'foundation-assets')}:/scenario:ro,z`,
              '--entrypoint',
              'node',
              'feedgen-e2e-stratos',
              '/scenario/driver.mjs',
            ])
            expect(
              await readFile(
                join(directory, 'foundation-assets/driver.mjs'),
                'utf8',
              ),
            ).toContain('distributed-concurrent-single-consume')
            expect(
              (await stat(join(directory, 'foundation-assets/driver.mjs')))
                .mode & 0o777,
            ).toBe(0o644)
            if (kind === 'missing') return 'no receipt'
            if (kind === 'malformed')
              return '{"suite":"request-proof-foundation","assertions":null}'
            return `runtime ready\n${JSON.stringify({ suite: suite.id, assertions })}\n`
          },
        })
        validateSuite(suite)
        if (kind === 'valid') expect(await run).toEqual(assertions)
        else await expect(run).rejects.toThrow()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})
