import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDriverCommand } from '../rules.js'
import { prepareBrowserRunner } from './standard-credential-transport.js'
import type { AssertionResult, ScenarioSuite } from '../rules.js'

export const suite: ScenarioSuite = {
  id: 'november-positive',
  requiredAssertions: [
    'schema-grant',
    'oauth-create',
    'oauth-read',
    'authorized-feed',
    'credential-read',
    'oauth-delete',
  ],
  coverage:
    'PDS-custody positive journey: OAuth create and delete, OAuth read, credential read with a verified record MAC, and authorized feed delivery. The remaining November journeys are not covered.',
  async run(context): Promise<AssertionResult[]> {
    const browserAssets = await prepareBrowserRunner(context.scratchDirectory)
    const require = createRequire(
      new URL('../../../clubhouse/package.json', import.meta.url),
    )
    const viteRequire = createRequire(require.resolve('vite'))
    const { build } = viteRequire('esbuild') as {
      build: (options: Record<string, unknown>) => Promise<unknown>
    }
    await build({
      entryPoints: [
        fileURLToPath(new URL('./november-positive-sdk.mjs', import.meta.url)),
      ],
      outfile: join(browserAssets, 'sdk.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
    })
    const output = await runDriverCommand(suite, () =>
      context.runCommand(
        'docker',
        [
          'compose',
          '--file',
          context.composeFile,
          '--project-name',
          context.projectName,
          '--project-directory',
          context.sandboxDirectory,
          'run',
          '--build',
          '--rm',
          '--no-deps',
          '--volume',
          `${browserAssets}:/scenario:ro,z`,
          'feedgen-e2e-browser',
          'november-positive',
        ],
        context.sandboxDirectory,
      ),
    )
    const line = output
      .split('\n')
      .map((item) => item.trim())
      .findLast((item) =>
        item.startsWith('{"suite":"november-positive","assertions":'),
      )
    if (!line)
      throw new Error(
        'Browser runner returned no november-positive assertion receipt',
      )
    const parsed = JSON.parse(line) as {
      suite?: string
      assertions?: AssertionResult[]
    }
    if (parsed.suite !== suite.id || !Array.isArray(parsed.assertions))
      throw new Error(
        'Browser runner returned an invalid november-positive assertion receipt',
      )
    return parsed.assertions
  },
}
