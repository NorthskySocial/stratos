import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AssertionResult, ScenarioSuite } from '../rules.js'

const appId = 'feed-errors-webapp'
const service = 'feed-errors-webapp'
const requiredAssertions = [
  'private-feed-loaded',
  'interrupted-feed-error',
  'public-feed-retained',
  'retry-recovered',
  'revoked-session-cleared',
  'late-response-isolated',
] as const

const definition = {
  version: 1,
  id: appId,
  services: [
    {
      service,
      environment: [],
      buildArguments: [
        {
          name: 'VITE_STRATOS_SERVICE_DID',
          source: { kind: 'web-did', host: 'stratos-e2e' },
        },
        {
          name: 'VITE_STRATOS_URL',
          source: { kind: 'host-url', host: 'stratos-e2e' },
        },
        {
          name: 'VITE_ATPROTO_HANDLE_RESOLVER',
          source: { kind: 'host-url', host: 'spaces-pds-e2e' },
        },
        {
          name: 'VITE_PLC_DIRECTORY',
          source: { kind: 'host-url', host: 'plc' },
        },
        {
          name: 'VITE_FEEDGEN_DID',
          source: { kind: 'web-did', host: 'feedgen-e2e' },
        },
      ],
    },
  ],
  routes: [
    { id: appId, service, host: 'webapp-e2e', port: 80 },
    {
      id: `${appId}-oauth`,
      service,
      hostname: 'webapp-e2e.atmosbox.internal',
      port: 80,
    },
  ],
  secrets: [],
}

const compose = `services:
  ${service}:
    build:
      context: ../stratos
      dockerfile: webapp/Dockerfile
      args:
        VITE_FEEDGEN_FEED: general
        VITE_WEBAPP_URL: https://webapp-e2e.atmosbox.internal
    read_only: true
    tmpfs:
      - /var/cache/nginx:rw,noexec,nosuid,size=16m,uid=0,gid=0,mode=0755
      - /var/run:rw,noexec,nosuid,size=4m,uid=0,gid=0,mode=0755
    cap_drop: [ALL]
    cap_add: [CHOWN, NET_BIND_SERVICE, SETGID, SETUID]
    security_opt: ['no-new-privileges:true']
    healthcheck:
      test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://127.0.0.1/']
      interval: 3s
      timeout: 3s
      retries: 20
`

async function signal(
  directory: string,
  name: string,
  browser: Promise<string>,
): Promise<void> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (
      await stat(join(directory, name))
        .then(() => true)
        .catch(() => false)
    )
      return
    await Promise.race([
      browser.then(() => {
        throw new Error(`Browser exited before ${name}`)
      }),
      new Promise((resolve) => setTimeout(resolve, 250)),
    ])
  }
  throw new Error(`Timed out waiting for browser signal ${name}`)
}

export const suite: ScenarioSuite = {
  id: 'feed-errors',
  requiredAssertions,
  async run(context): Promise<AssertionResult[]> {
    const stacks = join(context.sandboxDirectory, 'stacks')
    const registry = join(stacks, 'components.json')
    const components = JSON.parse(await readFile(registry, 'utf8')) as Array<{
      id: string
    }>
    if (components.some((component) => component.id === appId)) {
      throw new Error('Disposable sandbox already has the feed-errors app')
    }
    components.push({
      id: appId,
      file: `stacks/${appId}.yaml`,
      application: appId,
      definition: `stacks/${appId}.definition.json`,
    } as (typeof components)[number])
    await writeFile(registry, `${JSON.stringify(components, null, 2)}\n`)
    await writeFile(join(stacks, `${appId}.yaml`), compose)
    await writeFile(
      join(stacks, `${appId}.definition.json`),
      `${JSON.stringify(definition, null, 2)}\n`,
    )
    await context.runCommand(
      'deno',
      ['task', 'sandbox', 'apply', '--app', appId],
      context.sandboxDirectory,
    )
    await context.runCommand(
      'deno',
      ['task', 'sandbox', 'up', '--build'],
      context.sandboxDirectory,
    )
    const composeArgs = [
      'compose',
      '--project-name',
      context.projectName,
      '--project-directory',
      context.sandboxDirectory,
    ]
    await context.runCommand(
      'docker',
      [...composeArgs, 'restart', 'dns', 'gateway'],
      context.sandboxDirectory,
    )
    await context.runCommand(
      'docker',
      [...composeArgs, 'restart', 'feedgen-e2e-pds-spaces'],
      context.sandboxDirectory,
    )
    await context.runCommand(
      'deno',
      ['task', 'sandbox', 'up'],
      context.sandboxDirectory,
    )

    const control = join(context.sandboxDirectory, 'state/feed-errors-control')
    await mkdir(control)
    await chmod(control, 0o777)
    const browserMount = join(
      context.sandboxDirectory,
      'state/feed-errors.browser.mjs',
    )
    await copyFile(
      fileURLToPath(new URL('./feed-errors.browser.mjs', import.meta.url)),
      browserMount,
    )
    const browser = context.runCommand(
      'docker',
      [
        ...composeArgs,
        'run',
        '--rm',
        '--no-deps',
        '--volume',
        `${browserMount}:/runner/feed-errors.browser.mjs:ro,Z`,
        '--volume',
        `${control}:/runner/control:rw,Z`,
        '--entrypoint',
        'node',
        'feedgen-e2e-browser',
        '/runner/feed-errors.browser.mjs',
      ],
      context.sandboxDirectory,
    )

    try {
      await signal(control, 'ready', browser)
      await context.runCommand(
        'docker',
        [...composeArgs, 'stop', 'feedgen-e2e-rust'],
        context.sandboxDirectory,
      )
      await writeFile(join(control, 'interrupted'), '')
      await signal(control, 'failed', browser)
      await context.runCommand(
        'docker',
        [...composeArgs, 'start', 'feedgen-e2e-rust'],
        context.sandboxDirectory,
      )
      await context.runCommand(
        'deno',
        ['task', 'sandbox', 'up'],
        context.sandboxDirectory,
      )
      await writeFile(join(control, 'restored'), '')
      const output = await browser
      const receipt = output
        .split('\n')
        .map((line) => line.trim())
        .findLast((line) => line.startsWith('{"suite":"feed-errors"'))
      if (!receipt) throw new Error('Browser returned no feed-errors receipt')
      const result = JSON.parse(receipt) as {
        suite?: string
        assertions?: AssertionResult[]
      }
      if (result.suite !== 'feed-errors' || !Array.isArray(result.assertions)) {
        throw new Error('Browser returned an invalid feed-errors receipt')
      }
      return result.assertions
    } finally {
      // Leave the disposable private stack healthy for runner teardown, even on browser failure.
      await context.runCommand(
        'docker',
        [...composeArgs, 'start', 'feedgen-e2e-rust'],
        context.sandboxDirectory,
      )
    }
  },
}
