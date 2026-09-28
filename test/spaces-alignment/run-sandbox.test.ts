import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  command,
  ensureSeparatePaths,
  parseOptions,
  pinnedCheckout,
  runSandbox,
} from './run-sandbox.js'

const temporary: string[] = []
const originalPath = process.env.PATH

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'stratos-runner-test-'))
  temporary.push(path)
  return path
}

afterEach(async () => {
  process.env.PATH = originalPath
  delete process.env.RUNNER_TEST_FAIL_STEP
  delete process.env.RUNNER_TEST_EMPTY_ASSERTIONS
  delete process.env.RUNNER_TEST_MISSING_ACCOUNT
  delete process.env.RUNNER_TEST_FAIL_PDS_BUILD
  delete process.env.RUNNER_TEST_DOCKER_LOG
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

function initializeRepo(repo: string): void {
  execFileSync('git', ['init', '-q', repo])
  git(repo, 'config', 'user.name', 'Spike Spiegel')
  git(repo, 'config', 'user.email', 'spike@example.test')
}

describe('sandbox preflight', () => {
  it('requires exactly the five declared options', () => {
    const args = [
      '--sandbox-dir',
      '/tmp/aiab',
      '--source',
      '/tmp/source',
      '--suite',
      'baseline',
      '--report-dir',
      '/tmp/report',
      '--review-receipt',
      '/tmp/review.json',
    ]
    expect(parseOptions(args).suite).toBe('baseline')
    expect(() => parseOptions(args.slice(0, -2))).toThrow()
    expect(() => parseOptions([...args, '--suite', 'other'])).toThrow()
    expect(() =>
      parseOptions([...args.slice(0, 3), 'relative', ...args.slice(4)]),
    ).toThrow()
    expect(() =>
      parseOptions([...args.slice(0, 5), '--report-dir', ...args.slice(6)]),
    ).toThrow('Invalid argument')
    expect(() => parseOptions([...args, '--unknown', 'value'])).toThrow(
      'Invalid argument',
    )
    expect(() =>
      parseOptions([...args.slice(0, 5), 'bad/id', ...args.slice(6)]),
    ).toThrow('Invalid suite ID')
  })

  it('rejects source, sandbox, or report aliasing and reused report paths', async () => {
    const root = await directory()
    const source = await directory()
    const sandbox = await directory()
    const options = {
      source,
      sandboxDirectory: sandbox,
      reportDirectory: join(root, 'report'),
      suite: 'baseline',
      reviewReceipt: join(root, 'review.json'),
    }
    await expect(ensureSeparatePaths(options)).resolves.toBeUndefined()
    await expect(
      ensureSeparatePaths({ ...options, reportDirectory: source }),
    ).rejects.toThrow()
    await expect(
      ensureSeparatePaths({ ...options, sandboxDirectory: source }),
    ).rejects.toThrow()
    await expect(
      ensureSeparatePaths({
        ...options,
        reportDirectory: join(source, 'private'),
      }),
    ).rejects.toThrow('must not alias or contain')
    await writeFile(options.reportDirectory, '')
    await expect(ensureSeparatePaths(options)).rejects.toThrow()
  })

  it('rejects wrong and dirty pinned checkouts', async () => {
    const repo = await directory()
    execFileSync('git', ['init', '-q', repo])
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Spike Spiegel'])
    execFileSync('git', [
      '-C',
      repo,
      'config',
      'user.email',
      'spike@example.test',
    ])
    const manifest = join(repo, 'deno.json')
    await writeFile(manifest, '{"tasks":{}}\n')
    execFileSync('git', ['-C', repo, 'add', 'deno.json'])
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'Add manifest'])
    const revision = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const sha256 = createHash('sha256')
      .update(await readFile(manifest))
      .digest('hex')
    const pin = { url: repo, revision, sha256: { 'deno.json': sha256 } }
    await expect(pinnedCheckout(repo, pin)).resolves.toBe(repo)
    await expect(
      pinnedCheckout(repo, { ...pin, sha256: { 'deno.json': '0'.repeat(64) } }),
    ).rejects.toThrow('hash differs')
    await expect(
      pinnedCheckout(repo, { ...pin, revision: 'a'.repeat(40) }),
    ).rejects.toThrow()
    await writeFile(manifest, '{}\n')
    await expect(pinnedCheckout(repo, pin)).rejects.toThrow()
  })

  it('treats nonzero child exits as failures', async () => {
    const cwd = await directory()
    await expect(
      command(process.execPath, ['-e', 'process.exit(7)'], cwd),
    ).rejects.toThrow('exited 7')
  })

  it('exports the reviewed candidate, runs the pinned sandbox steps, and writes a sanitized receipt', async () => {
    const root = await directory()
    const candidateRepo = join(root, 'candidate')
    const sandboxRepo = join(root, 'sandbox')
    const bin = join(root, 'bin')
    const reportDirectory = join(root, 'report')
    await mkdir(candidateRepo)
    await mkdir(sandboxRepo)
    await mkdir(bin)
    initializeRepo(candidateRepo)
    initializeRepo(sandboxRepo)
    await writeFile(join(candidateRepo, 'README.md'), 'Faye baseline\n')
    git(candidateRepo, 'add', '.')
    git(candidateRepo, 'commit', '-qm', 'Add baseline')
    const baseSha = git(candidateRepo, 'rev-parse', 'HEAD')
    await mkdir(join(candidateRepo, 'test/spaces-alignment/scenarios'), {
      recursive: true,
    })
    await mkdir(join(candidateRepo, 'test/spaces-alignment/templates'), {
      recursive: true,
    })
    await writeFile(
      join(candidateRepo, 'test/spaces-alignment/scenarios/baseline.ts'),
      `export const suite = { id: 'baseline', requiredAssertions: ['browser-pass'], async run(context) {
        const output = await context.runCommand('docker', ['compose', 'run'], context.sandboxDirectory)
        if (!output.includes('browser-ok')) throw new Error('Browser failed')
        if (process.env.RUNNER_TEST_EMPTY_ASSERTIONS) return []
        return [{ id: 'browser-pass', status: 'passed' }]
      } }\n`,
    )
    await writeFile(
      join(
        candidateRepo,
        'test/spaces-alignment/templates/feedgen-ng-e2e.yaml',
      ),
      'services:\n  feedgen-e2e-pds-spaces:\n    image: ${SPACES_PDS_IMAGE_ID}\n',
    )
    await writeFile(
      join(
        candidateRepo,
        'test/spaces-alignment/templates/feedgen-ng-e2e-browser.mjs',
      ),
      'console.log("browser-ok")\n',
    )
    git(candidateRepo, 'add', '.')
    git(candidateRepo, 'commit', '-qm', 'Add candidate')
    await writeFile(join(candidateRepo, 'README.md'), 'Faye reviewed update\n')
    git(candidateRepo, 'add', 'README.md')
    git(candidateRepo, 'commit', '-qm', 'Refine candidate')
    const candidateSha = git(candidateRepo, 'rev-parse', 'HEAD')
    git(candidateRepo, 'checkout', '-qb', 'unrelated', baseSha)
    await writeFile(join(candidateRepo, 'unrelated.txt'), 'Different branch\n')
    git(candidateRepo, 'add', 'unrelated.txt')
    git(candidateRepo, 'commit', '-qm', 'Unrelated review base')
    const unrelatedSha = git(candidateRepo, 'rev-parse', 'HEAD')
    git(candidateRepo, 'checkout', '-q', candidateSha)
    git(
      candidateRepo,
      'tag',
      '-a',
      '-m',
      'Annotated review base',
      'review-base',
      baseSha,
    )
    const tagSha = git(candidateRepo, 'rev-parse', 'review-base')

    await mkdir(join(sandboxRepo, 'stacks'))
    await mkdir(join(sandboxRepo, 'runtime'))
    await writeFile(join(sandboxRepo, 'deno.json'), '{}\n')
    await writeFile(join(sandboxRepo, 'deno.lock'), '{}\n')
    await writeFile(
      join(sandboxRepo, 'stacks/feedgen-ng-e2e.yaml'),
      'services: {}\n',
    )
    await writeFile(
      join(sandboxRepo, 'runtime/feedgen-ng-e2e-browser.mjs'),
      'console.log("original")\n',
    )
    git(sandboxRepo, 'add', '.')
    git(sandboxRepo, 'commit', '-qm', 'Pin sandbox')
    const revision = git(sandboxRepo, 'rev-parse', 'HEAD')
    const manifestHash = createHash('sha256')
      .update(await readFile(join(sandboxRepo, 'deno.json')))
      .digest('hex')
    const lockHash = createHash('sha256')
      .update(await readFile(join(sandboxRepo, 'deno.lock')))
      .digest('hex')
    const sourcePins = {
      atmosphereInABox: {
        url: sandboxRepo,
        revision,
        sha256: { 'deno.json': manifestHash, 'deno.lock': lockHash },
        archivePaths: ['deno.json', 'deno.lock', 'stacks', 'runtime'],
      },
      spacesPds: {
        url: '/tmp/unused',
        revision: 'd'.repeat(40),
        dockerfile: 'services/pds/Dockerfile',
        lockfile: 'pnpm-lock.yaml',
      },
    }
    const reviewReceipt = join(root, 'review.json')
    const review = {
      candidateSha,
      baseSha,
      reviews: {
        standards: {
          model: 'gpt-5.6-terra',
          verdict: 'approved',
          reviewedSha: candidateSha,
          sessionId: 'standards-faye',
          evidenceRef: 'private:standards-faye',
          unresolvedBlockingFindings: 0,
        },
        spec: {
          model: 'gpt-5.6-terra',
          verdict: 'approved',
          reviewedSha: candidateSha,
          sessionId: 'spec-faye',
          evidenceRef: 'private:spec-faye',
          unresolvedBlockingFindings: 0,
        },
      },
    }
    await writeFile(reviewReceipt, JSON.stringify(review))
    const fakeDeno = `#!/usr/bin/env node
const fs = require('node:fs')
const assert = require('node:assert/strict')
assert.ok(process.env.DOCKER_CONFIG?.startsWith('/tmp/stratos-spaces-alignment-'))
assert.equal(fs.statSync(process.env.DOCKER_CONFIG).mode & 0o777, 0o700)
if (process.env.RUNNER_TEST_FAIL_STEP && process.argv.includes(process.env.RUNNER_TEST_FAIL_STEP)) process.exit(7)
if (process.argv.includes('seed')) {
  fs.mkdirSync('state', { recursive: true })
  fs.writeFileSync('state/accounts.json', JSON.stringify({ accounts: {
    'user1.pds1.atmosbox.test': { did: 'did:plc:faye', password: 'synthetic-one' },
    ...(process.env.RUNNER_TEST_MISSING_ACCOUNT ? {} : {
      'user2.pds1.atmosbox.test': { did: 'did:plc:ed', password: 'synthetic-two' }
    })
  } }))
}
`
    const fakeDocker = `#!/usr/bin/env node
const fs = require('node:fs')
const assert = require('node:assert/strict')
const args = process.argv.slice(2)
assert.ok(process.env.DOCKER_CONFIG?.startsWith('/tmp/stratos-spaces-alignment-'))
assert.equal(fs.statSync(process.env.DOCKER_CONFIG).mode & 0o777, 0o700)
if (args.includes('run')) {
  const accounts = JSON.parse(fs.readFileSync('state/browser-accounts.json', 'utf8')).accounts
  assert.equal(Object.keys(accounts).length, 2)
  assert.equal(accounts['user1.pds1.atmosbox.test'].password, 'synthetic-one')
  assert.equal(accounts['user2.pds1.atmosbox.test'].password, 'synthetic-two')
  console.log('browser-ok')
}
if (args.includes('down')) {
  assert.ok(args.includes('--project-name'))
  assert.ok(args.includes('--volumes'))
  assert.ok(args.includes('--remove-orphans'))
  fs.appendFileSync(process.env.RUNNER_TEST_DOCKER_LOG, process.env.DOCKER_CONFIG + '\\n')
}
`
    await writeFile(join(bin, 'deno'), fakeDeno, { mode: 0o755 })
    await writeFile(join(bin, 'docker'), fakeDocker, { mode: 0o755 })
    process.env.PATH = `${bin}:${originalPath}`
    const dockerLog = join(root, 'docker.log')
    process.env.RUNNER_TEST_DOCKER_LOG = dockerLog
    const options = {
      sandboxDirectory: sandboxRepo,
      source: candidateRepo,
      suite: 'baseline',
      reportDirectory,
      reviewReceipt,
    }
    const dependencies = {
      sourcePins,
      runnerSource: candidateRepo,
      async buildPds() {
        if (process.env.RUNNER_TEST_FAIL_PDS_BUILD)
          throw new Error('docker build failed with exit 17')
        return {
          sourceSha: 'd'.repeat(40),
          dockerfileSha256: 'e'.repeat(64),
          lockfileSha256: 'f'.repeat(64),
          imageId: `sha256:${'a'.repeat(64)}`,
          baseImages: [`sha256:${'b'.repeat(64)}`],
          buildExitCode: 0 as const,
        }
      },
    }
    await writeFile(
      reviewReceipt,
      JSON.stringify({ ...review, baseSha: candidateSha }),
    )
    await expect(runSandbox(options, dependencies)).rejects.toThrow(
      'distinct full Git SHAs',
    )
    await writeFile(
      reviewReceipt,
      JSON.stringify({ ...review, baseSha: unrelatedSha }),
    )
    await expect(runSandbox(options, dependencies)).rejects.toThrow(
      'ancestor of the candidate',
    )
    await writeFile(
      reviewReceipt,
      JSON.stringify({ ...review, baseSha: 'a'.repeat(40) }),
    )
    await expect(runSandbox(options, dependencies)).rejects.toThrow(
      'not a commit',
    )
    await writeFile(
      reviewReceipt,
      JSON.stringify({ ...review, baseSha: tagSha }),
    )
    await expect(runSandbox(options, dependencies)).rejects.toThrow(
      'not a commit',
    )
    await writeFile(reviewReceipt, JSON.stringify(review))
    await expect(
      runSandbox({ ...options, suite: 'unknown' }, dependencies),
    ).rejects.toThrow('Unknown or unavailable suite')
    await writeFile(join(candidateRepo, 'README.md'), 'Dirty candidate\n')
    await expect(runSandbox(options, dependencies)).rejects.toThrow(
      'Candidate tracked work is dirty',
    )
    git(candidateRepo, 'checkout', '--', 'README.md')
    await mkdir(reportDirectory)
    await expect(runSandbox(options, dependencies)).rejects.toThrow(
      'Report directory already exists',
    )
    await rm(reportDirectory, { recursive: true })
    process.env.RUNNER_TEST_FAIL_PDS_BUILD = '1'
    const pdsFailedReport = join(root, 'pds-failed-report')
    await expect(
      runSandbox(
        { ...options, reportDirectory: pdsFailedReport },
        dependencies,
      ),
    ).rejects.toThrow('docker build failed with exit 17')
    const pdsFailure = JSON.parse(
      await readFile(join(pdsFailedReport, 'failure.json'), 'utf8'),
    )
    expect(pdsFailure.completedSteps).toEqual([])
    expect(pdsFailure.failedStep).toBe('build-pds')
    expect(pdsFailure.error).toBe('docker build failed with exit 17')
    delete process.env.RUNNER_TEST_FAIL_PDS_BUILD
    process.env.RUNNER_TEST_FAIL_STEP = 'install'
    const failedReport = join(root, 'failed-report')
    await expect(
      runSandbox({ ...options, reportDirectory: failedReport }, dependencies),
    ).rejects.toThrow('deno task exited 7')
    const failure = JSON.parse(
      await readFile(join(failedReport, 'failure.json'), 'utf8'),
    )
    expect(failure.completedSteps).toEqual([])
    expect(failure.failedStep).toBe('install')
    delete process.env.RUNNER_TEST_FAIL_STEP
    process.env.RUNNER_TEST_FAIL_STEP = 'up'
    const upFailedReport = join(root, 'up-failed-report')
    await expect(
      runSandbox({ ...options, reportDirectory: upFailedReport }, dependencies),
    ).rejects.toThrow('deno task exited 7')
    const upFailure = JSON.parse(
      await readFile(join(upFailedReport, 'failure.json'), 'utf8'),
    )
    expect(upFailure.failedStep).toBe('up')
    expect(
      upFailure.completedSteps.map((step: { name: string }) => step.name),
    ).toEqual(['install', 'create', 'check'])
    delete process.env.RUNNER_TEST_FAIL_STEP
    process.env.RUNNER_TEST_EMPTY_ASSERTIONS = '1'
    await expect(
      runSandbox(
        { ...options, reportDirectory: join(root, 'empty-report') },
        dependencies,
      ),
    ).rejects.toThrow('returned zero assertions')
    delete process.env.RUNNER_TEST_EMPTY_ASSERTIONS
    process.env.RUNNER_TEST_MISSING_ACCOUNT = '1'
    await expect(
      runSandbox(
        { ...options, reportDirectory: join(root, 'missing-account-report') },
        dependencies,
      ),
    ).rejects.toThrow('did not seed both ordinary PDS accounts')
    delete process.env.RUNNER_TEST_MISSING_ACCOUNT
    await runSandbox(options, dependencies)
    const receipt = JSON.parse(
      await readFile(join(reportDirectory, 'receipt.json'), 'utf8'),
    )
    expect(receipt.candidateSha).toBe(candidateSha)
    expect(receipt.baseSha).toBe(baseSha)
    expect(receipt.atmosphereSourceSha).toBe(revision)
    expect(receipt.atmosphereFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(receipt.templateHashes['stacks/feedgen-ng-e2e.yaml']).toMatch(
      /^[0-9a-f]{64}$/,
    )
    expect(
      receipt.templateHashes['runtime/feedgen-ng-e2e-browser.mjs'],
    ).toMatch(/^[0-9a-f]{64}$/)
    expect(receipt.reviews).toEqual({
      standards: {
        model: 'gpt-5.6-terra',
        verdict: 'approved',
        sessionId: 'standards-faye',
        evidenceRef: 'private:standards-faye',
      },
      spec: {
        model: 'gpt-5.6-terra',
        verdict: 'approved',
        sessionId: 'spec-faye',
        evidenceRef: 'private:spec-faye',
      },
    })
    expect(receipt.suites).toEqual([
      {
        id: 'baseline',
        requiredAssertions: ['browser-pass'],
        passed: 1,
        skipped: 0,
        failed: 0,
      },
    ])
    expect(receipt.steps.map((step: { name: string }) => step.name)).toEqual([
      'install',
      'create',
      'check',
      'up',
      'seed',
    ])
    expect(JSON.stringify(receipt)).not.toContain('synthetic-one')
    expect((await stat(reportDirectory)).mode & 0o777).toBe(0o700)
    const dockerConfigs = (await readFile(dockerLog, 'utf8')).trim().split('\n')
    expect(dockerConfigs).toHaveLength(6)
    expect(new Set(dockerConfigs).size).toBe(6)
  })
})
