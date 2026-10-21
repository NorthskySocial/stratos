import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { installAtmosphereAssets } from './run-sandbox.js'

it('clones v0.7.2 and creates and checks the installed preset without containers', async () => {
  const pins = JSON.parse(
    await readFile(new URL('./sources.json', import.meta.url), 'utf8'),
  ).atmosphereInABox
  const root = await mkdtemp(join(tmpdir(), 'aiab-integration-'))
  const checkout = join(root, 'atmosphere')
  const run = (file: string, args: string[]) =>
    execFileSync(file, args, { cwd: checkout, encoding: 'utf8', stdio: 'pipe' })
  try {
    execFileSync('git', ['clone', '--no-checkout', pins.url, checkout], {
      stdio: 'pipe',
    })
    run('git', ['checkout', '--detach', pins.revision])
    expect(run('git', ['rev-parse', 'HEAD']).trim()).toBe(pins.revision)
    await installAtmosphereAssets(
      new URL('./atmosphere', import.meta.url).pathname,
      checkout,
    )
    run('deno', ['task', 'install'])
    run('deno', [
      'task',
      'sandbox',
      'create',
      '--pds',
      '1',
      '--pds-space',
      '1',
      '--users-per-pds',
      '2',
      '--preset',
      'feedgen-ng-e2e',
      '--project',
      'faye-integration',
      '--subnet',
      '172.29.0.0/24',
    ])
    run('deno', ['task', 'sandbox', 'check'])
    const compose = JSON.parse(
      run('docker', [
        'compose',
        '--profile',
        '*',
        '-f',
        'compose.yaml',
        'config',
        '--format',
        'json',
      ]),
    )
    for (const service of [
      'pds1',
      'pds-space1',
      'feedgen-e2e-stratos',
      'feedgen-e2e-rust',
      'feedgen-e2e-browser',
    ])
      expect(compose.services[service]).toBeDefined()
    expect(compose.services['pds-space1'].image).toMatch(/@sha256:/)
    const browserMounts = compose.services['feedgen-e2e-browser'].volumes
    expect(browserMounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: '/sandbox-state/pds-admin-password',
          read_only: true,
        }),
      ]),
    )
    const manifest = JSON.parse(
      await readFile(join(checkout, 'state/manifest.json'), 'utf8'),
    )
    expect(manifest.domain).toBe('atmosbox.test')
    const presets = JSON.parse(
      await readFile(join(checkout, 'stacks/presets.json'), 'utf8'),
    )
    expect(presets['feedgen-ng-e2e']).toEqual({
      applications: ['lexicon-authority', 'feedgen-ng-e2e'],
    })
    const authority = JSON.parse(
      await readFile(
        join(checkout, 'stacks/lexicon-authority.definition.json'),
        'utf8',
      ),
    )
    expect(authority.txt).toContainEqual({
      owner: '_lexicon.space.stratos.zone',
      value: { kind: 'authority', authority: 'lexicon-authority' },
    })
    const routes = await readFile(join(checkout, 'state/Caddyfile'), 'utf8')
    expect(routes).toContain('pds-space1.atmosbox.test')
    expect(routes).toContain('pds-space1:3000')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
