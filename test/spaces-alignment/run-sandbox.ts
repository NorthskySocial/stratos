import { randomUUID } from 'node:crypto'
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
import { buildAlphaPds } from './build-alpha-pds.js'
import type { PdsBuildReceipt, PdsSourcePin } from './build-alpha-pds.js'
import { CommandFailure, executeCommand, sha256File } from './command.js'
import {
  suiteExecutionOrder,
  validateAssertions,
  validateReviewReceipt,
} from './rules.js'
import type { AssertionResult, ReviewReceipt, ScenarioSuite } from './rules.js'

const harnessDirectory = dirname(fileURLToPath(import.meta.url))
const octoberPdsSuites = new Set([
  'writer-sync-contract',
  'credential-revocation-contract',
  'standard-credential-transport',
  'rust-production-interop',
  'october-interop',
])
const rustProbeSuites = new Set(['rust-production-interop', 'october-interop'])
interface SourcePins {
  atmosphereInABox: {
    url: string
    revision: string
    sha256: Record<string, string>
    archivePaths: string[]
  }
  octoberSpacesPds?: PdsSourcePin
}

const sources = JSON.parse(
  await readFile(join(harnessDirectory, 'sources.json'), 'utf8'),
) as SourcePins

export interface RunnerDependencies {
  sourcePins?: SourcePins
  runnerSource?: string
  buildPds?: (
    pin: PdsSourcePin,
    reportDirectory: string,
  ) => Promise<PdsBuildReceipt>
}

interface Options {
  sandboxDirectory: string
  source: string
  suite: string
  reportDirectory: string
  evidenceMode: 'review' | 'ci'
  reviewReceipt?: string
}

/**
 * Evidence that binds a sandbox run to a candidate, its base, and an optional
 * independent review receipt.
 */
export interface SandboxEvidence {
  candidate: string
  base: string
  receipt?: ReviewReceipt
}

interface CommandResult {
  output: string
  exitCode: 0
}

/**
 * Parse sandbox runner arguments and select review or CI evidence mode.
 * @param args - Process arguments after the script name.
 * @returns Validated runner options.
 */
export function parseOptions(args: string[]): Options {
  const names: Record<string, keyof Omit<Options, 'evidenceMode'>> = {
    '--sandbox-dir': 'sandboxDirectory',
    '--source': 'source',
    '--suite': 'suite',
    '--report-dir': 'reportDirectory',
    '--review-receipt': 'reviewReceipt',
  }
  const options: Partial<Options> = {}
  let ciEvidence = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ci-evidence') {
      if (ciEvidence) throw new Error('Invalid argument --ci-evidence')
      ciEvidence = true
      continue
    }
    const key = names[args[i]]
    const value = args[i + 1]
    if (!key || !value || value.startsWith('--') || options[key])
      throw new Error(`Invalid argument ${args[i] ?? ''}`)
    options[key] = value
    i++
  }
  for (const key of [
    'sandboxDirectory',
    'source',
    'reportDirectory',
  ] as const) {
    if (!options[key] || !isAbsolute(options[key]))
      throw new Error(`${key} must be an absolute path`)
  }
  if (!options.suite || !/^[a-z][a-z0-9-]*$/.test(options.suite))
    throw new Error('Invalid suite ID')
  if (ciEvidence && options.reviewReceipt)
    throw new Error('--ci-evidence and --review-receipt are mutually exclusive')
  if (ciEvidence && process.env.GITHUB_ACTIONS !== 'true')
    throw new Error('--ci-evidence is only valid in GitHub Actions')
  if (!ciEvidence && !options.reviewReceipt)
    throw new Error('--review-receipt is required outside GitHub Actions')
  if (options.reviewReceipt && !isAbsolute(options.reviewReceipt))
    throw new Error('reviewReceipt must be an absolute path')
  return ciEvidence
    ? ({ ...options, evidenceMode: 'ci' } as Options)
    : ({ ...options, evidenceMode: 'review' } as Options)
}

/**
 * Resolve the candidate and base commits for the selected evidence mode.
 * @param options - Validated runner options.
 * @param source - Candidate checkout.
 * @returns Candidate, base, and the review receipt when one is required.
 */
export async function resolveEvidence(
  options: Options,
  source: string,
): Promise<SandboxEvidence> {
  const candidate = await git(source, 'rev-parse', 'HEAD')
  let base: string
  let receipt: ReviewReceipt | undefined
  if (options.evidenceMode === 'ci') {
    base = process.env.GITHUB_BASE_SHA
      ? process.env.GITHUB_BASE_SHA
      : await git(source, 'rev-parse', '--verify', `${candidate}^`).catch(
          () => '',
        )
  } else {
    const reviewData = JSON.parse(
      await readFile(options.reviewReceipt!, 'utf8'),
    ) as unknown
    const claimedBase =
      reviewData !== null &&
      typeof reviewData === 'object' &&
      !Array.isArray(reviewData)
        ? (reviewData as Record<string, unknown>).baseSha
        : undefined
    receipt = validateReviewReceipt(
      reviewData,
      candidate,
      typeof claimedBase === 'string' ? claimedBase : '',
    )
    base = receipt.baseSha
  }
  const resolvedBase = await git(
    source,
    'rev-parse',
    '--verify',
    `${base}^{commit}`,
  ).catch(() => '')
  if (resolvedBase !== base)
    throw new Error('Evidence base is not a commit in the candidate checkout')
  try {
    await command(
      'git',
      ['merge-base', '--is-ancestor', base, candidate],
      source,
    )
  } catch {
    throw new Error('Evidence base must be an ancestor of the candidate')
  }
  return { candidate, base, receipt }
}

export class SandboxCommandFailure extends Error {
  constructor(
    readonly stdout: string,
    readonly stderr: string,
    message: string,
  ) {
    super(message)
  }
}

export async function command(
  file: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  try {
    const output = await executeCommand(file, args, {
      cwd,
      env: env ?? process.env,
    })
    return { output, exitCode: 0 }
  } catch (error) {
    if (error instanceof CommandFailure) {
      throw new SandboxCommandFailure(
        error.stdout,
        error.stderr,
        `${file} ${args[0] ?? ''} exited ${error.code ?? 'unknown'}`,
      )
    }
    throw new Error(`${file} ${args[0] ?? ''} exited unknown`)
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await command('git', args, cwd)).output.trim()
}

export interface PinnedCheckout {
  checkout: string
  acquisition?: string
}

export async function pinnedCheckout(
  path: string,
  pin: {
    url: string
    revision: string
    sha256: Record<string, string>
  },
): Promise<PinnedCheckout> {
  let checkout = path
  let acquisition: string | undefined
  try {
    if (!existsSync(checkout)) {
      acquisition = await mkdtemp(join(tmpdir(), 'stratos-aiab-source-'))
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
      (await git(checkout, 'status', '--porcelain', '--untracked-files=all'))
    ) {
      throw new Error('AiaB source is not the clean pinned checkout')
    }
    for (const [path, expected] of Object.entries(pin.sha256)) {
      if ((await sha256File(join(checkout, path))) !== expected)
        throw new Error(`Pinned AiaB ${path} hash differs`)
    }
    return { checkout, acquisition }
  } catch (error) {
    if (acquisition) await rm(acquisition, { recursive: true, force: true })
    throw error
  }
}

export function sanitizeOutput(output: string): string {
  const redacted = output
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      '[REDACTED]',
    )
    .replace(
      /(["']?(?:[a-z0-9]*[_-])*(?:admin[_-]?password|password|access[_-]?jwt|refresh[_-]?jwt|private[_-]?key|client[_-]?secret|signing[_-]?key|d|p|q|dp|dq|qi|k)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(^|[\s,{])((?:["']?(?:password|pass|token|secret|api[_-]?key)["']?)\s*[:=]\s*["']?)[^"'\s,}\]]+/gim,
      '$1$2[REDACTED]',
    )
    .replace(
      /((?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|dpop)\s+)[^\s,]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /([?&](?:access_token|api[_-]?key|password|pass|token|secret)=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(/(https?:\/\/[^\s:/]+:)[^@\s]+@/gi, '$1[REDACTED]@')
    .trim()
  if (!redacted) return ''
  const outputLimit = 8_000
  if (redacted.length <= outputLimit) return redacted
  const truncationMarker = '\n[output truncated; showing beginning and end]\n'
  const retainedLength = outputLimit - truncationMarker.length
  const beginningLength = Math.ceil(retainedLength / 2)
  const endingLength = Math.floor(retainedLength / 2)
  return `${redacted.slice(0, beginningLength)}${truncationMarker}${redacted.slice(-endingLength)}`
}

function logStepOutput(name: string, output: string): void {
  const sanitized = sanitizeOutput(output)
  if (sanitized) console.log(`AiaB [${name}] output:\n${sanitized}`)
}

async function logFailedUpDiagnostics(
  composeFile: string,
  projectName: string,
  atmosphere: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const composeArgs = [
    'compose',
    '--file',
    composeFile,
    '--project-name',
    projectName,
    '--project-directory',
    atmosphere,
  ]
  for (const [name, args] of [
    ['up:build', [...composeArgs, 'build', '--progress', 'plain']],
    ['up:status', [...composeArgs, 'ps', '--all', '--format', 'json']],
  ]) {
    console.log(`AiaB [${name}]: docker ${args.join(' ')}`)
    try {
      logStepOutput(
        name,
        (await command('docker', args, atmosphere, env)).output,
      )
    } catch (error) {
      if (error instanceof SandboxCommandFailure) {
        logStepOutput(name, error.stdout)
        logStepOutput(name, error.stderr)
      }
    }
  }
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
  pins: SourcePins,
): Promise<{
  atmosphereFingerprint: string
  templateHashes: Record<string, string>
}> {
  const atmosphere = join(workspace, 'atmosphereinabox')
  const stratos = join(workspace, 'stratos')
  await mkdir(atmosphere)
  await mkdir(stratos)
  const archive = join(workspace, 'aiab-source.tar')
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
  const atmosphereFingerprint = await sha256File(archive)
  await command('tar', ['-xf', archive, '-C', atmosphere], workspace)
  const candidateArchive = join(workspace, 'candidate-source.tar')
  await command(
    'git',
    ['archive', '--format=tar', '--output', candidateArchive, candidate],
    source,
  )
  await command('tar', ['-xf', candidateArchive, '-C', stratos], workspace)
  const templateHashes = await installAtmosphereAssets(
    join(stratos, 'test/spaces-alignment/atmosphere'),
    atmosphere,
  )
  return { atmosphereFingerprint, templateHashes }
}

const feedgenComponent = {
  id: 'feedgen-ng-e2e',
  file: 'stacks/feedgen-ng-e2e.yaml',
  application: 'feedgen-ng-e2e',
  definition: 'stacks/feedgen-ng-e2e.definition.json',
}

const feedgenPreset = {
  applications: ['lexicon-authority', 'feedgen-ng-e2e'],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export async function installAtmosphereAssets(
  assets: string,
  atmosphere: string,
): Promise<Record<string, string>> {
  const componentsPath = join(atmosphere, 'stacks/components.json')
  const componentsData = JSON.parse(
    await readFile(componentsPath, 'utf8'),
  ) as unknown
  if (!Array.isArray(componentsData) || !componentsData.every(isRecord))
    throw new Error('AiaB components registry has an invalid shape')
  const existingComponent = componentsData.find(
    (component) => component.id === feedgenComponent.id,
  )
  if (existingComponent && !sameJson(existingComponent, feedgenComponent))
    throw new Error('AiaB component ID conflicts with feedgen-ng-e2e')

  const presetsPath = join(atmosphere, 'stacks/presets.json')
  const presetsData = JSON.parse(await readFile(presetsPath, 'utf8')) as unknown
  if (!isRecord(presetsData))
    throw new Error('AiaB presets registry has an invalid shape')
  const existingPreset = presetsData['feedgen-ng-e2e']
  if (existingPreset !== undefined && !sameJson(existingPreset, feedgenPreset))
    throw new Error('AiaB preset ID conflicts with feedgen-ng-e2e')

  const hashes: Record<string, string> = {}
  for (const path of [
    'stacks/lexicon-authority.definition.json',
    'examples/lexicon-fixtures/zone.stratos.space.feed.json',
    'stacks/feedgen-ng-e2e.yaml',
    'stacks/feedgen-ng-e2e.definition.json',
    'stacks/feedgen-ng-e2e-browser.Dockerfile',
    'stacks/feedgen-ng-local/identity.Dockerfile',
    'stacks/feedgen-ng-local/feedgen-identity.mjs',
    'runtime/feedgen-ng-e2e-browser.mjs',
  ]) {
    const destination = join(atmosphere, path)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(assets, path), destination)
    hashes[path] = await sha256File(destination)
  }
  if (!existingComponent) componentsData.push(feedgenComponent)
  if (existingPreset === undefined)
    presetsData['feedgen-ng-e2e'] = feedgenPreset
  await writeFile(componentsPath, JSON.stringify(componentsData))
  await writeFile(presetsPath, JSON.stringify(presetsData))
  hashes['stacks/components.json'] = await sha256File(componentsPath)
  hashes['stacks/presets.json'] = await sha256File(presetsPath)
  return hashes
}

function sandboxEnvironment(dockerConfig: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('COMPOSE_'),
      ),
    ),
    DOCKER_CONFIG: dockerConfig,
    COMPOSE_PROFILES: '',
  }
}

async function labelContainerFiles(
  paths: string[],
  cwd: string,
): Promise<void> {
  try {
    await command('selinuxenabled', [], cwd)
  } catch {
    return
  }
  await command('chcon', ['-t', 'container_file_t', ...paths], cwd)
}

async function initializeSpacePdsData(
  composeFile: string,
  projectName: string,
  atmosphere: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await command(
      'docker',
      [
        'compose',
        '--file',
        composeFile,
        '--project-name',
        projectName,
        '--project-directory',
        atmosphere,
        'run',
        '--rm',
        '--no-deps',
        '--user',
        '0:0',
        '--entrypoint',
        'sh',
        'pds-space1',
        '-ec',
        `owner=$(stat -c %u:%g /data)
test "$owner" = 0:0
contents=$(find /data -mindepth 1 -maxdepth 1 -print -quit)
test -z "$contents"
chmod 0750 /data
chown 1000:1000 /data`,
      ],
      atmosphere,
      env,
    )
  } catch (error) {
    throw new Error(
      `Space PDS volume initialization failed: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    )
  }
}

export async function runSandbox(
  options: Options,
  dependencies: RunnerDependencies = {},
): Promise<void> {
  const pins = dependencies.sourcePins ?? sources
  await ensureSeparatePaths(options)
  const source = await realpath(options.source)
  const evidence = await resolveEvidence(options, source)
  const { candidate, base, receipt } = evidence
  if (await git(source, 'status', '--porcelain', '--untracked-files=all'))
    throw new Error('Candidate work is dirty')
  if (
    source !==
    (await realpath(
      dependencies.runnerSource ?? join(harnessDirectory, '../..'),
    ))
  )
    throw new Error('Runner must execute from the candidate checkout')
  const suites = suiteExecutionOrder(
    options.suite,
    await discoverSuites(source),
  )
  const sandbox = await pinnedCheckout(
    options.sandboxDirectory,
    pins.atmosphereInABox,
  )
  const sandboxCheckout = sandbox.checkout
  try {
    await mkdir(options.reportDirectory, { recursive: false, mode: 0o700 })
  } catch (error) {
    if (sandbox.acquisition)
      await rm(sandbox.acquisition, { recursive: true, force: true })
    throw error
  }
  let workspace: string
  try {
    workspace = await mkdtemp(join(tmpdir(), 'stratos-spaces-alignment-'))
  } catch (error) {
    if (sandbox.acquisition)
      await rm(sandbox.acquisition, { recursive: true, force: true })
    throw error
  }
  const projectName = `stratos-${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const atmosphere = join(workspace, 'atmosphereinabox')
  const composeFile = join(atmosphere, 'compose.yaml')
  const dockerConfig = join(workspace, 'docker-config')
  const childEnvironment = sandboxEnvironment(dockerConfig)
  const steps: Array<{ name: string; exitCode: 0 }> = []
  const results: Record<string, AssertionResult[]> = {}
  let octoberPds: PdsBuildReceipt | undefined
  let failedStep = 'docker-config'
  let gateError: unknown
  let summary: Record<string, unknown> | undefined
  const runStep = async (
    name: string,
    file: string,
    args: string[],
  ): Promise<string> => {
    failedStep = name
    console.log(`AiaB [${name}]: ${file} ${args.join(' ')}`)
    try {
      const result = await command(file, args, atmosphere, childEnvironment)
      if (name !== 'seed') logStepOutput(name, result.output)
      steps.push({ name, exitCode: result.exitCode })
      return result.output
    } catch (error) {
      if (error instanceof SandboxCommandFailure && name !== 'seed') {
        logStepOutput(name, error.stdout)
        logStepOutput(name, error.stderr)
      }
      if (name === 'up' && existsSync(composeFile))
        await logFailedUpDiagnostics(
          composeFile,
          projectName,
          atmosphere,
          childEnvironment,
        )
      throw error
    }
  }
  try {
    await mkdir(dockerConfig, { mode: 0o700 })
    failedStep = 'export-sources'
    const { atmosphereFingerprint, templateHashes } = await exportSources(
      sandboxCheckout,
      source,
      candidate,
      workspace,
      pins,
    )
    if (suites.some((suite) => octoberPdsSuites.has(suite.id))) {
      failedStep = 'build-october-pds'
      if (!pins.octoberSpacesPds)
        throw new Error('October PDS source pin is missing')
      const octoberReport = join(workspace, 'october-pds')
      await mkdir(octoberReport, { mode: 0o700 })
      octoberPds = await (dependencies.buildPds ?? buildAlphaPds)(
        pins.octoberSpacesPds,
        octoberReport,
      )
    }
    if (rustProbeSuites.has(options.suite)) {
      failedStep = 'prepare-browser-dockerfile'
      const browserDockerfile = join(
        atmosphere,
        'stacks/feedgen-ng-e2e-browser.Dockerfile',
      )
      const original = await readFile(browserDockerfile, 'utf8')
      const rustDockerfile = await readFile(
        join(workspace, 'stratos/stratos-feedgen-ng/Dockerfile'),
        'utf8',
      )
      const cargoCommand =
        'RUN cargo build --locked --release --package stratos-feedgen-ng'
      const builderSource = rustDockerfile.split('FROM debian:')[0]
      if (!builderSource.includes(cargoCommand))
        throw new Error('Rust cargo build command is missing')
      const driverPath = 'runtime/feedgen-ng-e2e-browser.mjs'
      if (!original.includes(driverPath))
        throw new Error('Browser driver path is missing')
      const builder = rustDockerfile
        .split('FROM debian:')[0]
        .replace(
          cargoCommand,
          'RUN cargo build --locked --release --package stratos-feedgen-ng --example space_interop_probe',
        )
      await writeFile(
        browserDockerfile,
        builder +
          original.replace(
            driverPath,
            'test/spaces-alignment/atmosphere/runtime/feedgen-ng-e2e-browser.mjs',
          ) +
          '\nCOPY --from=builder /workspace/target/release/examples/space_interop_probe /usr/local/bin/space_interop_probe\n',
      )
      templateHashes['stacks/feedgen-ng-e2e-browser.Dockerfile'] =
        await sha256File(browserDockerfile)
    }
    failedStep = 'prepare-stack'
    const stackPath = join(atmosphere, 'stacks/feedgen-ng-e2e.yaml')
    const sourceStack = await readFile(stackPath, 'utf8')
    const stack = rustProbeSuites.has(options.suite)
      ? sourceStack.replace(
          'context: .\n      dockerfile: stacks/feedgen-ng-e2e-browser.Dockerfile',
          'context: ../stratos\n      dockerfile: ../atmosphereinabox/stacks/feedgen-ng-e2e-browser.Dockerfile',
        )
      : sourceStack
    await writeFile(stackPath, stack)

    if (octoberPds) {
      const octoberImageId = octoberPds.imageId
      const octoberStack = await readFile(
        join(
          workspace,
          'stratos/test/spaces-alignment/templates/october-pds.yaml',
        ),
        'utf8',
      )
      if (!octoberStack.includes('${OCTOBER_PDS_IMAGE_ID}'))
        throw new Error('October PDS image placeholder is missing')
      await writeFile(
        stackPath,
        (await readFile(stackPath, 'utf8')).replace(
          '\nvolumes:\n',
          () =>
            '\n' +
            octoberStack
              .replace('${OCTOBER_PDS_IMAGE_ID}', octoberImageId)
              .split('\n')
              .map((line) => (line ? '  ' + line : line))
              .join('\n') +
            '\nvolumes:\n  feedgen-e2e-pds-october-data: {}\n',
        ),
      )
      const definitionPath = join(
        atmosphere,
        'stacks/feedgen-ng-e2e.definition.json',
      )
      const definition = JSON.parse(
        await readFile(definitionPath, 'utf8'),
      ) as Record<string, unknown[]>
      const extraPath = join(
        workspace,
        'stratos/test/spaces-alignment/templates/october-pds.definition.json',
      )
      const extra = JSON.parse(await readFile(extraPath, 'utf8')) as Record<
        string,
        unknown[]
      >
      for (const key of ['services', 'routes', 'secrets', 'volumeInit'])
        definition[key].push(...extra[key])
      const browser = (
        definition.services as Array<{
          service: string
          secretFiles?: unknown[]
        }>
      ).find((service) => service.service === 'feedgen-e2e-browser')!
      if (rustProbeSuites.has(options.suite)) {
        browser.secretFiles!.push({
          secret: 'feedgen-e2e-signing-key',
          name: 'probe-service-signing-key',
          uid: 1001,
          gid: 1001,
        })
      }
      browser.secretFiles!.push({
        secret: 'feedgen-e2e-october-admin',
        name: 'october-admin-password',
        uid: 1001,
        gid: 1001,
      })
      await writeFile(definitionPath, JSON.stringify(definition))
      const updatedStack = (await readFile(stackPath, 'utf8')).replace(
        'IDENTITY_PRIVATE_ORIGINS: ',
        'IDENTITY_PRIVATE_ORIGINS: https://october-pds-e2e.atmosbox.test,https://faye.october-pds-e2e.atmosbox.test,https://edward.october-pds-e2e.atmosbox.test,https://rustfaye.october-pds-e2e.atmosbox.test,https://rustedward.october-pds-e2e.atmosbox.test,',
      )
      await writeFile(stackPath, updatedStack)
      templateHashes['stacks/october-pds.yaml'] = await sha256File(
        join(
          workspace,
          'stratos/test/spaces-alignment/templates/october-pds.yaml',
        ),
      )
      templateHashes['stacks/october-pds.definition.json'] =
        await sha256File(extraPath)
    }

    if (options.suite === 'rust-production-interop') {
      await writeFile(
        stackPath,
        (await readFile(stackPath, 'utf8')).replace(
          "      STRATOS_PORT: '3100'",
          "      STRATOS_SPACE_HTTP_CREDENTIAL_TTL_SECONDS: '10'\n      STRATOS_PORT: '3100'",
        ),
      )
    }
    await runStep('install', 'deno', ['task', 'install'])
    await runStep('create', 'deno', [
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
      projectName,
      '--subnet',
      'auto',
    ])
    if (!existsSync(composeFile))
      throw new Error('Sandbox did not generate compose.yaml')
    const sandboxManifest = JSON.parse(
      await readFile(join(atmosphere, 'state/manifest.json'), 'utf8'),
    ) as { domain?: string }
    if (sandboxManifest.domain !== 'atmosbox.test')
      throw new Error(
        'Pinned sandbox domain differs from the OAuth route templates',
      )
    const pdsSecrets = JSON.parse(
      await readFile(join(atmosphere, 'state/pds-space1.secrets.json'), 'utf8'),
    ) as { adminPassword: string }
    await writeFile(
      join(atmosphere, 'state/browser-pds-admin'),
      pdsSecrets.adminPassword,
      { mode: 0o444 },
    )
    const applicationSecrets = [
      'feedgen-e2e-browser-password',
      'feedgen-e2e-signing-key',
      'feedgen-e2e-storage-key',
    ].map((secret) =>
      join(atmosphere, 'state/apps/feedgen-ng-e2e/secret-files', secret),
    )
    await labelContainerFiles(
      [join(atmosphere, 'state/browser-pds-admin'), ...applicationSecrets],
      atmosphere,
    )
    failedStep = 'initialize-space-pds'
    await initializeSpacePdsData(
      composeFile,
      projectName,
      atmosphere,
      childEnvironment,
    )
    await runStep('check', 'deno', ['task', 'sandbox', 'check'])
    await runStep('build-tools', 'docker', [
      'compose',
      '--file',
      composeFile,
      '--project-name',
      projectName,
      '--project-directory',
      atmosphere,
      '--progress',
      'plain',
      'build',
      'runner',
    ])
    await runStep('up', 'deno', ['task', 'sandbox', 'up', '--build'])
    await runStep('seed', 'deno', ['task', 'sandbox', 'seed'])
    failedStep = 'prepare-browser-accounts'
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
      failedStep = `suite:${suite.id}`
      console.log(`AiaB [suite:${suite.id}]`)
      results[suite.id] = await suite.run({
        sandboxDirectory: atmosphere,
        composeFile,
        projectName,
        scratchDirectory: workspace,
        runCommand: async (file, args, cwd) =>
          (await command(file, args, cwd, childEnvironment)).output,
      })
      validateAssertions(suite, results[suite.id])
    }
    failedStep = 'write-receipt'
    await enforceReportContents(options.reportDirectory)
    summary = {
      candidateSha: candidate,
      baseSha: base,
      evidenceMode: options.evidenceMode,
      ...(receipt
        ? {
            reviewedSha: receipt.candidateSha,
            reviews: summarizeReviews(receipt),
          }
        : {}),
      atmosphereSourceSha: pins.atmosphereInABox.revision,
      atmosphereFingerprint,
      templateHashes,
      octoberPds,
      pdsServices: {
        primary: { service: 'pds-space1' },
        ...(octoberPds
          ? {
              october: {
                service: 'feedgen-e2e-pds-october',
                build: octoberPds,
              },
            }
          : {}),
      },
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
  } catch (error) {
    gateError = error
  }

  const cleanup: Record<string, unknown> = {}
  const cleanupErrors: Error[] = []
  if (existsSync(composeFile)) {
    try {
      await command(
        'docker',
        [
          'compose',
          '--file',
          composeFile,
          '--project-name',
          projectName,
          '--project-directory',
          atmosphere,
          'down',
          '--volumes',
          '--remove-orphans',
        ],
        atmosphere,
        childEnvironment,
      )
      cleanup.compose = { status: 'passed', exitCode: 0 }
    } catch (error) {
      const message = 'Cleanup command failed'
      cleanup.compose = { status: 'failed', error: message }
      cleanup.recoveryComposeFile = composeFile
      cleanupErrors.push(new Error(`Sandbox cleanup failed: ${message}`))
    }
  } else {
    cleanup.compose = { status: 'not-needed' }
  }
  for (const [imageKind, image] of [['octoberImage', octoberPds]] as const) {
    if (image) {
      try {
        await command(
          'docker',
          ['image', 'rm', image.imageTag],
          atmosphere,
          childEnvironment,
        )
        cleanup[imageKind] = {
          status: 'passed',
          exitCode: 0,
          tag: image.imageTag,
        }
      } catch (error) {
        const message = 'Cleanup command failed'
        cleanup[imageKind] = {
          status: 'failed',
          error: message,
          tag: image.imageTag,
        }
        cleanupErrors.push(new Error(`PDS image cleanup failed: ${message}`))
      }
    }
  }
  cleanup.status = cleanupErrors.length === 0 ? 'passed' : 'failed'
  if (cleanupErrors.length > 0) {
    const cleanupError =
      cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, 'Sandbox cleanup failed')
    gateError = gateError
      ? new AggregateError(
          [gateError, cleanupError],
          'Sandbox gate and cleanup failed',
        )
      : cleanupError
  }

  await enforceReportContents(options.reportDirectory)
  if (gateError) {
    await writeFile(
      join(options.reportDirectory, 'failure.json'),
      JSON.stringify(
        {
          candidateSha: candidate,
          baseSha: base,
          evidenceMode: options.evidenceMode,
          projectName,
          failedStep,
          completedSteps: steps,
          error: 'Sandbox gate failed',
          cleanup,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    if (cleanup.status !== 'failed')
      await rm(workspace, { recursive: true, force: true })
    if (sandbox.acquisition)
      await rm(sandbox.acquisition, { recursive: true, force: true })
    throw gateError
  }

  await writeFile(
    join(options.reportDirectory, 'receipt.json'),
    JSON.stringify({ ...summary, cleanup }, null, 2),
    { mode: 0o600 },
  )
  await rm(workspace, { recursive: true, force: true })
  if (sandbox.acquisition)
    await rm(sandbox.acquisition, { recursive: true, force: true })
}

export async function enforceReportContents(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true }))
    await rm(join(directory, entry.name), { recursive: true })
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
    console.error('Sandbox gate failed')
    process.exitCode = 1
  })
}
