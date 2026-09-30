import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CommandFailure, executeCommand, sha256File } from './command.js'

export interface PdsSourcePin {
  url: string
  revision: string
  dockerfile: string
  lockfile: string
}

export interface PdsBuildReceipt {
  sourceSha: string
  dockerfileSha256: string
  lockfileSha256: string
  imageId: string
  imageTag: string
  baseImages: string[]
  buildExitCode: 0
}

async function command(
  file: string,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    return (
      await executeCommand(file, args, {
        cwd,
        env: env ?? process.env,
      })
    ).trim()
  } catch (error) {
    const code =
      error instanceof CommandFailure ? (error.code ?? 'unknown') : 'unknown'
    const step = args[0] === 'image' ? 'image inspect' : (args[0] ?? 'command')
    throw new Error(`${file} ${step} failed with exit ${code}`)
  }
}

export async function buildAlphaPds(
  pin: PdsSourcePin,
  reportDirectory: string,
): Promise<PdsBuildReceipt> {
  if (!/^[0-9a-f]{40}$/.test(pin.revision))
    throw new Error('Invalid PDS source revision')
  const acquisition = await mkdtemp(join(tmpdir(), 'stratos-pds-source-'))
  const source = join(acquisition, 'atproto')
  try {
    await command('git', [
      'clone',
      '--no-checkout',
      '--filter=blob:none',
      pin.url,
      source,
    ])
    await command('git', ['fetch', 'origin', pin.revision], source)
    await command('git', ['checkout', '--detach', pin.revision], source)
    const sourceSha = await command('git', ['rev-parse', 'HEAD'], source)
    const status = await command(
      'git',
      ['status', '--porcelain', '--untracked-files=no'],
      source,
    )
    if (sourceSha !== pin.revision || status)
      throw new Error('Pinned PDS source is dirty or has drifted')

    const dockerfileSha256 = await sha256File(join(source, pin.dockerfile))
    const lockfileSha256 = await sha256File(join(source, pin.lockfile))
    const dockerfile = await readFile(join(source, pin.dockerfile), 'utf8')
    const fromLines = [
      ...dockerfile.matchAll(/^FROM[ \t]+(\S+)(?:[ \t]+AS[ \t]+(\S+))?/gim),
    ]
    const stageNames = new Set(
      fromLines.map((match) => match[2]?.toLowerCase()).filter(Boolean),
    )
    const baseTags = [
      ...new Set(
        fromLines
          .map((match) => match[1])
          .filter(
            (tag) => !tag.startsWith('$') && !stageNames.has(tag.toLowerCase()),
          ),
      ),
    ]
    const baseImages = await Promise.all(
      baseTags.map(async (tag) => {
        await command('docker', ['pull', tag])
        return await command('docker', [
          'image',
          'inspect',
          '--format',
          '{{.Id}}',
          tag,
        ])
      }),
    )
    const tag = `stratos-spaces-pds-${randomUUID()}:local`
    const imageIdPath = join(reportDirectory, 'pds-image.id')
    const dockerConfig = join(acquisition, 'docker-config')
    await mkdir(dockerConfig, { mode: 0o700 })
    await command(
      'docker',
      [
        'build',
        '--progress=plain',
        '--file',
        join(source, pin.dockerfile),
        '--label',
        `org.opencontainers.image.revision=${pin.revision}`,
        '--iidfile',
        imageIdPath,
        '--tag',
        tag,
        source,
      ],
      undefined,
      { ...process.env, DOCKER_CONFIG: dockerConfig },
    )
    const imageId = (await readFile(imageIdPath, 'utf8')).trim()
    if (!/^sha256:[0-9a-f]{64}$/.test(imageId))
      throw new Error('PDS build produced no immutable image ID')
    return {
      sourceSha,
      dockerfileSha256,
      lockfileSha256,
      imageId,
      imageTag: tag,
      baseImages,
      buildExitCode: 0,
    }
  } finally {
    await rm(acquisition, { recursive: true, force: true })
  }
}
