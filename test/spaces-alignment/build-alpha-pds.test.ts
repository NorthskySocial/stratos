import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildAlphaPds } from './build-alpha-pds.js'

const temporary: string[] = []
const originalPath = process.env.PATH

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'stratos-pds-test-'))
  temporary.push(path)
  return path
}

afterEach(async () => {
  process.env.PATH = originalPath
  delete process.env.RUNNER_TEST_FAIL_DOCKER_BUILD
  delete process.env.RUNNER_TEST_FAIL_DOCKER_INSPECT
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('pinned PDS build', () => {
  it('records pinned source hashes, base image identity and immutable image ID', async () => {
    const root = await directory()
    const source = join(root, 'source')
    const bin = join(root, 'bin')
    const report = join(root, 'report')
    await mkdir(join(source, 'services/pds'), { recursive: true })
    await mkdir(bin)
    await mkdir(report)
    const dockerfile = 'FROM node:24-alpine AS build\nFROM build\n'
    const lockfile = 'lockfileVersion: 9.0\n'
    await writeFile(join(source, 'services/pds/Dockerfile'), dockerfile)
    await writeFile(join(source, 'pnpm-lock.yaml'), lockfile)
    execFileSync('git', ['init', '-q', source])
    execFileSync('git', ['-C', source, 'config', 'user.name', 'Faye Valentine'])
    execFileSync('git', [
      '-C',
      source,
      'config',
      'user.email',
      'faye@example.test',
    ])
    execFileSync('git', ['-C', source, 'add', '.'])
    execFileSync('git', ['-C', source, 'commit', '-qm', 'Pin fixture'])
    const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const dockerScript = `#!/usr/bin/env node
const fs = require('node:fs')
const assert = require('node:assert/strict')
const args = process.argv.slice(2)
if (args[0] === 'pull') { assert.equal(args[1], 'node:24-alpine'); process.exit(0) }
if (args[0] === 'image' && args[1] === 'inspect') {
  assert.deepEqual(args.slice(2), ['--format', '{{.Id}}', 'node:24-alpine'])
  if (process.env.RUNNER_TEST_FAIL_DOCKER_INSPECT) {
    console.error('synthetic private failure detail')
    process.exit(19)
  }
  console.log('sha256:${'b'.repeat(64)}')
  process.exit(0)
}
if (args[0] === 'build') {
  assert.ok(process.env.DOCKER_CONFIG?.startsWith('/tmp/stratos-pds-source-'))
  assert.equal(fs.statSync(process.env.DOCKER_CONFIG).mode & 0o777, 0o700)
  assert.ok(args.includes('--progress=plain'))
  const index = args.indexOf('--iidfile')
  if (index < 0) process.exit(2)
  assert.ok(args[args.indexOf('--file') + 1].endsWith('/services/pds/Dockerfile'))
  assert.equal(args[args.indexOf('--label') + 1], 'org.opencontainers.image.revision=${revision}')
  assert.match(args[args.indexOf('--tag') + 1], /^stratos-spaces-pds-[0-9a-f-]+:local$/)
  assert.ok(args.at(-1).endsWith('/atproto'))
  if (process.env.RUNNER_TEST_FAIL_DOCKER_BUILD) {
    console.error('synthetic private failure detail')
    process.exit(17)
  }
  fs.writeFileSync(args[index + 1], 'sha256:${'c'.repeat(64)}\\n')
  process.exit(0)
}
process.exit(2)
`
    await writeFile(join(bin, 'docker'), dockerScript, { mode: 0o755 })
    process.env.PATH = `${bin}:${originalPath}`

    const receipt = await buildAlphaPds(
      {
        url: source,
        revision,
        dockerfile: 'services/pds/Dockerfile',
        lockfile: 'pnpm-lock.yaml',
      },
      report,
    )
    expect(receipt).toEqual({
      sourceSha: revision,
      dockerfileSha256: createHash('sha256').update(dockerfile).digest('hex'),
      lockfileSha256: createHash('sha256').update(lockfile).digest('hex'),
      imageId: `sha256:${'c'.repeat(64)}`,
      baseImages: [`sha256:${'b'.repeat(64)}`],
      buildExitCode: 0,
    })
    expect((await readFile(join(report, 'pds-image.id'), 'utf8')).trim()).toBe(
      receipt.imageId,
    )

    process.env.RUNNER_TEST_FAIL_DOCKER_BUILD = '1'
    await expect(
      buildAlphaPds(
        {
          url: source,
          revision,
          dockerfile: 'services/pds/Dockerfile',
          lockfile: 'pnpm-lock.yaml',
        },
        report,
      ),
    ).rejects.toThrow(/^docker build failed with exit 17$/)
    delete process.env.RUNNER_TEST_FAIL_DOCKER_BUILD
    process.env.RUNNER_TEST_FAIL_DOCKER_INSPECT = '1'
    await expect(
      buildAlphaPds(
        {
          url: source,
          revision,
          dockerfile: 'services/pds/Dockerfile',
          lockfile: 'pnpm-lock.yaml',
        },
        report,
      ),
    ).rejects.toThrow(/^docker image inspect failed with exit 19$/)
  })

  it('rejects an invalid revision before acquisition', async () => {
    const report = await directory()
    await expect(
      buildAlphaPds(
        {
          url: '/tmp/unused',
          revision: 'floating',
          dockerfile: 'services/pds/Dockerfile',
          lockfile: 'pnpm-lock.yaml',
        },
        report,
      ),
    ).rejects.toThrow('Invalid PDS source revision')
    await expect(
      buildAlphaPds(
        {
          url: '/tmp/unused',
          revision: `x${'a'.repeat(40)}`,
          dockerfile: 'services/pds/Dockerfile',
          lockfile: 'pnpm-lock.yaml',
        },
        report,
      ),
    ).rejects.toThrow('Invalid PDS source revision')
    await expect(
      buildAlphaPds(
        {
          url: '/tmp/unused',
          revision: `${'a'.repeat(40)}x`,
          dockerfile: 'services/pds/Dockerfile',
          lockfile: 'pnpm-lock.yaml',
        },
        report,
      ),
    ).rejects.toThrow('Invalid PDS source revision')
  })
})
