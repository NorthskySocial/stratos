import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import type { AssertionResult, ScenarioSuite } from '../rules.js'

const requiredAssertions = [
  'sdk-discovers-both-custodies',
  'authority-and-host-agree',
  'selected-space-write',
  'space-write-is-private',
  'unresolved-custody-sends-no-credentials',
] as const

export const suite: ScenarioSuite = {
  id: 'client-custody',
  requiredAssertions,
  async run(context): Promise<AssertionResult[]> {
    const fromScenario = createRequire(import.meta.url)
    const fromTsx = createRequire(fromScenario.resolve('tsx'))
    const esbuild = fromTsx('esbuild') as {
      build(options: Record<string, unknown>): Promise<void>
    }
    const bundle = join(context.reportDirectory, 'client-custody-sdk.mjs')
    const source = resolve(
      fileURLToPath(
        new URL('../../../stratos-client/src/index.ts', import.meta.url),
      ),
    )
    await esbuild.build({
      entryPoints: [source],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
    })
    const script = fileURLToPath(
      new URL('./client-custody.mjs', import.meta.url),
    )
    const output = await context.runCommand(
      'docker',
      [
        'compose',
        '--project-name',
        context.projectName,
        '--project-directory',
        context.sandboxDirectory,
        'run',
        '--rm',
        '--no-deps',
        '--entrypoint',
        'node',
        '--volume',
        `${bundle}:/runner/client-custody-sdk.mjs:ro`,
        '--volume',
        `${script}:/runner/client-custody.mjs:ro`,
        'feedgen-e2e-browser',
        '/runner/client-custody.mjs',
      ],
      context.sandboxDirectory,
    )
    const line = output
      .split('\n')
      .map((item) => item.trim())
      .findLast((item) =>
        item.startsWith('{"suite":"client-custody","assertions":'),
      )
    if (!line)
      throw new Error('Client custody runner returned no assertion receipt')
    const parsed = JSON.parse(line) as {
      suite?: string
      assertions?: AssertionResult[]
    }
    if (
      parsed.suite !== 'client-custody' ||
      !Array.isArray(parsed.assertions)
    ) {
      throw new Error(
        'Client custody runner returned an invalid assertion receipt',
      )
    }
    return parsed.assertions
  },
}
