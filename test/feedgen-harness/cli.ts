import { chmod, lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  countPostsByBoundary,
  createSmallOracleFixture,
  fingerprintFixture,
} from './oracle.js'
import { compareFeedEndpoints } from './compare.js'
import { runRustContracts, type RustContractKind } from './contracts.js'
import { inspectCgroupResources } from './resources.js'

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

interface CompareReport {
  command: 'compare'
  reportPath: string
  outcome: 'matched' | 'mismatch'
  reason?: string
  tsStatus: number
  rustStatus: number
}

interface ContractReport {
  command: RustContractKind
  implementation: 'rust'
  reportPath: string
  assertions: number
}

async function main(args: readonly string[]): Promise<void> {
  if (args[0] === 'limits') return reportLimits(args)
  if (args[0] === 'compare') return reportComparison(args)
  if (args[0] === 'privacy' || args[0] === 'recovery')
    return reportRustContracts(args[0], args)
  if (args[0] !== 'oracle')
    throw new Error(
      'Supported commands: oracle, limits, compare, privacy, recovery',
    )
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

async function reportRustContracts(
  kind: RustContractKind,
  args: readonly string[],
): Promise<void> {
  if (implementationFrom(args) !== 'rust') {
    throw new Error(`${kind} supports only --implementation rust`)
  }
  const assertions = await runRustContracts(kind)
  const directory = await mkdtemp(join(tmpdir(), 'stratos-feedgen-harness-'))
  await chmod(directory, 0o700)
  const path = join(directory, `${kind}.json`)
  const report: ContractReport = {
    command: kind,
    implementation: 'rust',
    reportPath: path,
    assertions,
  }
  await writeFile(path, `${JSON.stringify(report)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(report)}\n`)
}

async function reportComparison(args: readonly string[]): Promise<void> {
  const tsBaseUrl = requiredOption(args, '--ts-url')
  const rustBaseUrl = requiredOption(args, '--rust-url')
  const authorization = await readPrivateAuthorization(
    requiredOption(args, '--authorization-file'),
  )
  const feed = requiredOption(args, '--feed')
  const cursor = optionalOption(args, '--cursor')
  const limit = optionalPositiveInteger(args, '--limit')
  const requestTimeoutMs = optionalPositiveInteger(args, '--timeout-ms')
  if (requestTimeoutMs !== undefined && requestTimeoutMs > 30_000) {
    throw new Error('--timeout-ms must not exceed 30000')
  }
  const comparison = await compareFeedEndpoints({
    tsBaseUrl,
    rustBaseUrl,
    authorization,
    feed,
    cursor,
    limit,
    requestTimeoutMs,
    allowRemote: args.includes('--allow-remote'),
  })
  const directory = await mkdtemp(join(tmpdir(), 'stratos-feedgen-harness-'))
  await chmod(directory, 0o700)
  const path = join(directory, 'compare.json')
  const report: CompareReport = {
    command: 'compare',
    reportPath: path,
    ...comparison,
  }
  await writeFile(path, `${JSON.stringify(report)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (comparison.outcome !== 'matched') process.exitCode = 1
}

async function reportLimits(args: readonly string[]): Promise<void> {
  const position = args.indexOf('--cgroup-root')
  const root = position === -1 ? '/sys/fs/cgroup' : args[position + 1]
  if (!root) throw new Error('limits requires a cgroup root')
  const result = await inspectCgroupResources(root)
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

function requiredOption(args: readonly string[], name: string): string {
  const value = optionalOption(args, name)
  if (!value) throw new Error(`${name} is required`)
  return value
}

function optionalOption(
  args: readonly string[],
  name: string,
): string | undefined {
  const position = args.indexOf(name)
  return position === -1 ? undefined : args[position + 1]
}

function optionalPositiveInteger(
  args: readonly string[],
  name: string,
): number | undefined {
  const value = optionalOption(args, name)
  if (value === undefined) return undefined
  if (!/^[1-9]\d*$/.test(value))
    throw new Error(`${name} must be a positive integer`)
  return Number(value)
}

async function readPrivateAuthorization(path: string): Promise<string> {
  const details = await lstat(path)
  if (!details.isFile() || details.isSymbolicLink() || details.mode & 0o077) {
    throw new Error('authorization file must be a non-symlink private file')
  }
  const authorization = (await readFile(path, 'utf8')).trim()
  if (!authorization) throw new Error('authorization file is empty')
  return authorization
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'harness failed'}\n`,
  )
  process.exitCode = 1
})
