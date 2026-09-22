import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  countPostsByBoundary,
  createSmallOracleFixture,
  fingerprintFixture,
} from './oracle.js'
import { inspectCgroupLimits } from './resources.js'

interface OracleReport {
  command: 'oracle'
  implementation: 'ts' | 'rust'
  reportPath: string
  fixture: {
    actors: number
    boundaries: number
    posts: number
    fingerprint: string
  }
  postsByBoundary: Readonly<Record<string, number>>
}

async function main(args: readonly string[]): Promise<void> {
  if (args[0] === 'limits') return reportLimits(args)
  if (args[0] !== 'oracle')
    throw new Error('Supported commands: oracle, limits')
  const implementation = implementationFrom(args)
  const fixture = createSmallOracleFixture()
  const directory = await mkdtemp(join(tmpdir(), 'stratos-feedgen-harness-'))
  await chmod(directory, 0o700)
  const path = join(directory, 'oracle.json')
  const report: OracleReport = {
    command: 'oracle',
    implementation,
    reportPath: path,
    fixture: {
      actors: fixture.actors.length,
      boundaries: fixture.boundaries.length,
      posts: fixture.posts.length,
      fingerprint: fingerprintFixture(fixture),
    },
    postsByBoundary: countPostsByBoundary(fixture),
  }
  await writeFile(path, `${JSON.stringify(report)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(report)}\n`)
}

async function reportLimits(args: readonly string[]): Promise<void> {
  const position = args.indexOf('--cgroup-root')
  const root = position === -1 ? '/sys/fs/cgroup' : args[position + 1]
  if (!root) throw new Error('limits requires a cgroup root')
  const result = await inspectCgroupLimits(root)
  process.stdout.write(`${JSON.stringify({ command: 'limits', ...result })}\n`)
  if (!result.passed) process.exitCode = 1
}

function implementationFrom(args: readonly string[]): 'ts' | 'rust' {
  const position = args.indexOf('--implementation')
  const value = position === -1 ? undefined : args[position + 1]
  if (value === 'ts' || value === 'rust') return value
  throw new Error(
    'oracle requires --implementation ts or --implementation rust',
  )
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'harness failed'}\n`,
  )
  process.exitCode = 1
})
