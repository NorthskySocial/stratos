import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { buildAlphaPds } from './build-alpha-pds.js'
import type { PdsBuildReceipt, PdsSourcePin } from './build-alpha-pds.js'
import {
  suiteExecutionOrder,
  validateAssertions,
  validateReviewReceipt,
} from './rules.js'
import type { AssertionResult, ReviewReceipt, ScenarioSuite } from './rules.js'

const exec = promisify(execFile)
const harnessDirectory = dirname(fileURLToPath(import.meta.url))
interface SourcePins {
  atmosphereInABox: {
    url: string
    revision: string
    sha256: Record<string, string>
    archivePaths: string[]
  }
  spacesPds: PdsSourcePin
}

const sources = JSON.parse(
  await readFile(join(harnessDirectory, 'sources.json'), 'utf8'),
) as SourcePins

export interface RunnerDependencies {
  sourcePins?: SourcePins
  runnerSource?: string
  buildPds?: (
    pin: SourcePins['spacesPds'],
    reportDirectory: string,
  ) => Promise<PdsBuildReceipt>
}

interface Options {
  sandboxDirectory: string
  source: string
  suite: string
  reportDirectory: string
  reviewReceipt: string
}

interface CommandResult {
  output: string
  exitCode: 0
}

export function parseOptions(args: string[]): Options {
  const names: Record<string, keyof Options> = {
    '--sandbox-dir': 'sandboxDirectory',
    '--source': 'source',
    '--suite': 'suite',
    '--report-dir': 'reportDirectory',
    '--review-receipt': 'reviewReceipt',
  }
  const options: Partial<Options> = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]]
    const value = args[i + 1]
    if (!key || !value || value.startsWith('--') || options[key])
      throw new Error(`Invalid argument ${args[i] ?? ''}`)
    options[key] = value
  }
  if (Object.keys(options).length !== Object.keys(names).length)
    throw new Error('Five required options must be supplied')
  for (const key of [
    'sandboxDirectory',
    'source',
    'reportDirectory',
    'reviewReceipt',
  ] as const) {
    if (!isAbsolute(options[key]!))
      throw new Error(`${key} must be an absolute path`)
  }
  if (!/^[a-z][a-z0-9-]*$/.test(options.suite!))
    throw new Error('Invalid suite ID')
  return options as Options
}

export async function command(
  file: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  try {
    const { stdout } = await exec(file, args, {
      cwd,
      env: env ?? process.env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 45 * 60_000,
    })
    return { output: stdout, exitCode: 0 }
  } catch (error) {
    throw new Error(
      `${file} ${args[0] ?? ''} exited ${(error as { code?: number | string }).code ?? 'unknown'}`,
    )
  }
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await command('git', args, cwd)).output.trim()
}

export async function pinnedCheckout(
  path: string,
  pin: { url: string; revision: string; sha256: Record<string, string> },
): Promise<string> {
  let checkout = path
  if (!existsSync(checkout)) {
    const acquisition = await mkdtemp(join(tmpdir(), 'stratos-aiab-source-'))
    checkout = join(acquisition, 'atmosphereinabox')
    await command(
      'git',
      ['clone', '--no-checkout', pin.url, checkout],
      acquisition,
    )
    await command('git', ['fetch', 'origin', pin.revision], checkout)
    await command('git', ['checkout', '--detach', pin.revision], checkout)
  }
  if (
    (await git(checkout, 'rev-parse', '--show-toplevel')) !==
      (await realpath(checkout)) ||
    (await git(checkout, 'rev-parse', 'HEAD')) !== pin.revision ||
    (await git(checkout, 'status', '--porcelain', '--untracked-files=no'))
  ) {
    throw new Error('AiaB source is not the clean pinned checkout')
  }
  for (const [path, expected] of Object.entries(pin.sha256)) {
    if ((await sha256(join(checkout, path))) !== expected)
      throw new Error(`Pinned AiaB ${path} hash differs`)
  }
  return checkout
}

async function discoverSuites(source: string): Promise<ScenarioSuite[]> {
  const suiteDirectory = join(source, 'test/spaces-alignment/scenarios')
  const files = (await readdir(suiteDirectory)).filter((file) =>
    /^[a-z][a-z0-9-]*\.ts$/.test(file),
  )
  const tracked = new Set(
    (
      await git(source, 'ls-files', '--', 'test/spaces-alignment/scenarios')
    ).split('\n'),
  )
  const suites: ScenarioSuite[] = []
  for (const file of files) {
    if (!tracked.has(`test/spaces-alignment/scenarios/${file}`))
      throw new Error(`Untracked scenario: ${file}`)
    const module = (await import(
      pathToFileURL(join(suiteDirectory, file)).href
    )) as { suite?: ScenarioSuite }
    if (!module.suite) throw new Error(`Scenario ${file} has no suite export`)
    suites.push(module.suite)
  }
  return suites
}

export async function ensureSeparatePaths(options: Options): Promise<void> {
  const source = await realpath(options.source)
  const sandbox = existsSync(options.sandboxDirectory)
    ? await realpath(options.sandboxDirectory)
    : resolve(options.sandboxDirectory)
  const report = resolve(options.reportDirectory)
  if (existsSync(report))
    throw new Error('Report directory already exists; use a fresh private path')
  for (const [left, right] of [
    [source, sandbox],
    [source, report],
    [sandbox, report],
  ]) {
    if (
      left === right ||
      !relative(left, right).startsWith('..') ||
      !relative(right, left).startsWith('..')
    ) {
      throw new Error(
        'Source, sandbox and report paths must not alias or contain each other',
      )
    }
  }
}

async function exportSources(
  sandboxCheckout: string,
  source: string,
  candidate: string,
  workspace: string,
  reportDirectory: string,
  pins: SourcePins,
): Promise<{
  atmosphereFingerprint: string
  templateHashes: Record<string, string>
}> {
  const atmosphere = join(workspace, 'atmosphereinabox')
  const stratos = join(workspace, 'stratos')
  await mkdir(atmosphere)
  await mkdir(stratos)
  const archive = join(reportDirectory, 'aiab-source.tar')
  await command(
    'git',
    [
      'archive',
      '--format=tar',
      '--output',
      archive,
      pins.atmosphereInABox.revision,
      ...pins.atmosphereInABox.archivePaths,
    ],
    sandboxCheckout,
  )
  const atmosphereFingerprint = await sha256(archive)
  await command('tar', ['-xf', archive, '-C', atmosphere], workspace)
  const candidateArchive = join(reportDirectory, 'candidate-source.tar')
  await command(
    'git',
    ['archive', '--format=tar', '--output', candidateArchive, candidate],
    source,
  )
  await command('tar', ['-xf', candidateArchive, '-C', stratos], workspace)
  const templateFiles = [
    ['templates/feedgen-ng-e2e.yaml', 'stacks/feedgen-ng-e2e.yaml'],
    [
      'templates/feedgen-ng-e2e-browser.mjs',
      'runtime/feedgen-ng-e2e-browser.mjs',
    ],
  ]
  const templateHashes: Record<string, string> = {}
  for (const [from, to] of templateFiles) {
    const sourcePath = join(stratos, 'test/spaces-alignment', from)
    const destination = join(atmosphere, to)
    await copyFile(sourcePath, destination)
    templateHashes[to] = await sha256(sourcePath)
  }
  return { atmosphereFingerprint, templateHashes }
}

export async function runSandbox(
  options: Options,
  dependencies: RunnerDependencies = {},
): Promise<void> {
  const pins = dependencies.sourcePins ?? sources
  await ensureSeparatePaths(options)
  const source = await realpath(options.source)
  const candidate = await git(source, 'rev-parse', 'HEAD')
  const base = await git(source, 'rev-parse', 'HEAD^')
  if (await git(source, 'status', '--porcelain', '--untracked-files=no'))
    throw new Error('Candidate tracked work is dirty')
  if (
    source !==
    (await realpath(
      dependencies.runnerSource ?? join(harnessDirectory, '../..'),
    ))
  )
    throw new Error('Runner must execute from the candidate checkout')
  const receipt = validateReviewReceipt(
    JSON.parse(await readFile(options.reviewReceipt, 'utf8')) as unknown,
    candidate,
    base,
  )
  const suites = suiteExecutionOrder(
    options.suite,
    await discoverSuites(source),
  )
  const sandboxCheckout = await pinnedCheckout(
    options.sandboxDirectory,
    pins.atmosphereInABox,
  )
  await mkdir(options.reportDirectory, { recursive: false, mode: 0o700 })
  const workspace = await mkdtemp(join(tmpdir(), 'stratos-spaces-alignment-'))
  const projectName = `stratos-${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const atmosphere = join(workspace, 'atmosphereinabox')
  const steps: Array<{ name: string; exitCode: 0 }> = []
  const results: Record<string, AssertionResult[]> = {}
  const runStep = async (
    name: string,
    file: string,
    args: string[],
  ): Promise<string> => {
    const result = await command(file, args, atmosphere)
    steps.push({ name, exitCode: result.exitCode })
    return result.output
  }
  try {
    const { atmosphereFingerprint, templateHashes } = await exportSources(
      sandboxCheckout,
      source,
      candidate,
      workspace,
      options.reportDirectory,
      pins,
    )
    const pds = await (dependencies.buildPds ?? buildAlphaPds)(
      pins.spacesPds,
      options.reportDirectory,
    )
    const stackPath = join(atmosphere, 'stacks/feedgen-ng-e2e.yaml')
    const stack = await readFile(stackPath, 'utf8')
    if (!stack.includes('${SPACES_PDS_IMAGE_ID}'))
      throw new Error('PDS image placeholder is missing')
    await writeFile(
      stackPath,
      stack.replace('${SPACES_PDS_IMAGE_ID}', pds.imageId),
    )

    await runStep('install', 'deno', ['task', 'install'])
    await runStep('create', 'deno', [
      'task',
      'sandbox',
      'create',
      '--pds',
      '1',
      '--users-per-pds',
      '2',
      '--preset',
      'feedgen-ng-e2e',
      '--project',
      projectName,
      '--subnet',
      'auto',
    ])
    await runStep('check', 'deno', ['task', 'sandbox', 'check'])
    await runStep('up', 'deno', ['task', 'sandbox', 'up', '--build'])
    await runStep('seed', 'deno', ['task', 'sandbox', 'seed'])
    const state = JSON.parse(
      await readFile(join(atmosphere, 'state/accounts.json'), 'utf8'),
    ) as {
      accounts?: Record<string, { did?: string; password?: string }>
    }
    const ordinaryAccounts = Object.fromEntries(
      Object.entries(state.accounts ?? {})
        .filter(([handle]) => /^user[12]\.pds1\./.test(handle))
        .map(([handle, account]) => [
          handle,
          { did: account.did, password: account.password },
        ]),
    )
    if (
      Object.keys(ordinaryAccounts).length !== 2 ||
      Object.values(ordinaryAccounts).some(
        (account) => !account.did || !account.password,
      )
    ) {
      throw new Error('AiaB did not seed both ordinary PDS accounts')
    }
    const browserAccounts = join(atmosphere, 'state/browser-accounts.json')
    await writeFile(
      browserAccounts,
      JSON.stringify({ accounts: ordinaryAccounts }),
      { mode: 0o444 },
    )
    await chmod(browserAccounts, 0o444)
    for (const suite of suites) {
      results[suite.id] = await suite.run({
        sandboxDirectory: atmosphere,
        projectName,
        reportDirectory: options.reportDirectory,
        runCommand: async (file, args, cwd) =>
          (await command(file, args, cwd)).output,
      })
      validateAssertions(suite, results[suite.id])
    }
    const summary = {
      candidateSha: candidate,
      baseSha: base,
      reviewedSha: receipt.candidateSha,
      reviews: summarizeReviews(receipt),
      atmosphereSourceSha: pins.atmosphereInABox.revision,
      atmosphereFingerprint,
      templateHashes,
      pds,
      projectName,
      suites: suites.map((suite) => ({
        id: suite.id,
        requiredAssertions: suite.requiredAssertions,
        passed: results[suite.id].length,
        skipped: 0,
        failed: 0,
      })),
      steps,
    }
    await writeFile(
      join(options.reportDirectory, 'receipt.json'),
      JSON.stringify(summary, null, 2),
      { mode: 0o600 },
    )
  } catch (error) {
    await writeFile(
      join(options.reportDirectory, 'failure.json'),
      JSON.stringify(
        {
          candidateSha: candidate,
          baseSha: base,
          projectName,
          completedSteps: steps,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    throw error
  } finally {
    await command(
      'docker',
      [
        'compose',
        '--project-name',
        projectName,
        '--project-directory',
        atmosphere,
        'down',
        '--volumes',
        '--remove-orphans',
      ],
      atmosphere,
    ).catch(() => {})
    await rm(workspace, { recursive: true, force: true })
  }
}

function summarizeReviews(
  receipt: ReviewReceipt,
): Record<
  string,
  { model: string; sessionId: string; evidenceRef: string; verdict: string }
> {
  return Object.fromEntries(
    (['standards', 'spec'] as const).map((kind) => [
      kind,
      {
        model: receipt.reviews[kind].model,
        sessionId: receipt.reviews[kind].sessionId,
        evidenceRef: receipt.reviews[kind].evidenceRef,
        verdict: receipt.reviews[kind].verdict,
      },
    ]),
  )
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runSandbox(parseOptions(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
