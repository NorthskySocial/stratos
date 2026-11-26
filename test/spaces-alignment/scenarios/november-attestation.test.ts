import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAttestationFixture } from './november-attestation.driver.js'
import type { ScenarioContext } from '../rules.js'

const fixturePath = 'stratos-service/tests/space-credential-app-gating.test.ts'
const assertions = [
  'allowList space without attestation → AttestationRequired',
  'listed client with valid attestation → OK exactly once (replay rejected)',
  'allowList space: the authority host audience mints, the retired audience → AttestationRequired',
].map((title) => ({ title, status: 'passed' }))

describe('November attestation evidence', () => {
  let scratchDirectory: string

  beforeEach(async () => {
    scratchDirectory = await mkdtemp(
      join(tmpdir(), 'stratos-attestation-test-'),
    )
  })

  afterEach(async () => {
    await rm(scratchDirectory, { recursive: true, force: true })
  })

  function context(
    rows: typeof assertions,
    paths = [fixturePath],
  ): ScenarioContext {
    return {
      scratchDirectory,
      sandboxDirectory: '/sandbox',
      composeFile: '/sandbox/compose.yaml',
      projectName: 'attestation',
      async runCommand(file, args, cwd) {
        const source = fileURLToPath(new URL('../../../', import.meta.url))
        const report = join(scratchDirectory, 'attestation-verifier.json')
        expect(cwd).toBe(source)
        expect(file).toBe(join(source, 'node_modules/.bin/vitest'))
        expect(args).toEqual([
          'run',
          '--project',
          'stratos-service',
          fixturePath,
          '-t',
          expect.stringContaining('listed client with valid attestation'),
          '--reporter=json',
          '--outputFile',
          report,
        ])
        await writeFile(
          report,
          JSON.stringify({
            testResults: paths.map((path) => ({
              name: join(cwd, path),
              assertionResults: rows,
            })),
          }),
        )
        return ''
      },
    }
  }

  it('records the three named fixture observations without closing the live journey', async () => {
    await expect(
      runAttestationFixture(context(assertions)),
    ).resolves.toMatchObject({
      id: 'current-delegation-and-client-attestation-accepted',
      tier: 'in-process',
      artifact: fixturePath,
      observation: expect.stringMatching(
        /accepted a valid allow-listed client/,
      ),
      remainingHostQuestion: expect.stringMatching(/HTTPS metadata origin/),
    })
  })

  it.each([
    [],
    assertions.slice(0, 2),
    [...assertions.slice(0, 2), { ...assertions[2], status: 'skipped' }],
    [...assertions.slice(0, 2), assertions[0]],
    [...assertions, { title: 'unrelated fixture check', status: 'passed' }],
  ])('refuses omitted, skipped or substituted assertions', async (...rows) => {
    await expect(runAttestationFixture(context(rows))).rejects.toThrow(
      'did not report every selected test as passed',
    )
  })

  it('refuses the same titles from a different source file', async () => {
    await expect(
      runAttestationFixture(context(assertions, ['another.test.ts'])),
    ).rejects.toThrow('did not report every selected test as passed')
  })
  it.each([[], [fixturePath, 'another.test.ts']])(
    'requires exactly one result file even if the selected assertions match',
    async (...paths) => {
      await expect(
        runAttestationFixture(context(assertions, paths)),
      ).rejects.toThrow('did not report every selected test as passed')
    },
  )
})
