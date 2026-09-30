import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AssertionResult, ScenarioSuite } from '../rules.js'

const appId = 'space-delete-webapp'
const service = 'space-delete-webapp'
const requiredAssertions = [
  'webapp-oauth-delete-grant',
  'pds-delete-target',
  'feed-removes-only-target',
  'other-author-denied',
  'stratos-delete-preserved',
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
    { id: 'space-delete-webapp', service, host: 'webapp-e2e', port: 80 },
    {
      id: 'space-delete-webapp-oauth',
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

export const suite: ScenarioSuite = {
  id: 'space-delete',
  requiredAssertions,
  async run(context): Promise<AssertionResult[]> {
    const stacks = join(context.sandboxDirectory, 'stacks')
    const registry = join(stacks, 'components.json')
    const components = JSON.parse(await readFile(registry, 'utf8')) as Array<{
      id: string
    }>
    if (components.some((component) => component.id === appId)) {
      throw new Error('Disposable sandbox already has the space-delete app')
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
    await context.runCommand(
      'docker',
      [
        'compose',
        '--file',
        join(context.sandboxDirectory, 'compose.yaml'),
        '--project-name',
        context.projectName,
        '--project-directory',
        context.sandboxDirectory,
        'restart',
        'dns',
        'gateway',
      ],
      context.sandboxDirectory,
    )
    await context.runCommand(
      'docker',
      [
        'compose',
        '--file',
        join(context.sandboxDirectory, 'compose.yaml'),
        '--project-name',
        context.projectName,
        '--project-directory',
        context.sandboxDirectory,
        'restart',
        'feedgen-e2e-pds-spaces',
      ],
      context.sandboxDirectory,
    )
    await context.runCommand(
      'deno',
      ['task', 'sandbox', 'up'],
      context.sandboxDirectory,
    )

    const browserScript = fileURLToPath(
      new URL('./space-delete.browser.mjs', import.meta.url),
    )
    const browserMount = join(
      context.sandboxDirectory,
      'state/space-delete.browser.mjs',
    )
    await copyFile(browserScript, browserMount)
    const output = await context.runCommand(
      'docker',
      [
        'compose',
        '--file',
        join(context.sandboxDirectory, 'compose.yaml'),
        '--project-name',
        context.projectName,
        '--project-directory',
        context.sandboxDirectory,
        'run',
        '--rm',
        '--no-deps',
        '--volume',
        `${browserMount}:/runner/space-delete.browser.mjs:ro,Z`,
        '--entrypoint',
        'node',
        'feedgen-e2e-browser',
        '/runner/space-delete.browser.mjs',
      ],
      context.sandboxDirectory,
    )
    const receipt = output
      .split('\n')
      .map((line) => line.trim())
      .findLast((line) => line.startsWith('{"suite":"space-delete"'))
    if (!receipt) throw new Error('Browser returned no space-delete receipt')
    const result = JSON.parse(receipt) as {
      suite?: string
      assertions?: AssertionResult[]
    }
    if (!Array.isArray(result.assertions)) {
      throw new Error('Browser returned an invalid space-delete receipt')
    }
    return result.assertions
  },
}
