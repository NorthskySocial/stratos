import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sha256 } from './hash.js'

const exec = promisify(execFile)

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
    const { stdout } = await exec(file, args, {
      cwd,
      env: env ?? process.env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 45 * 60_000,
    })
    return stdout.trim()
  } catch (error) {
    const code = (error as { code?: string | number }).code ?? 'unknown'
    const step = args[0] === 'image' ? 'image inspect' : (args[0] ?? 'command')
    throw new Error(`${file} ${step} failed with exit ${code}`, {
      cause: error,
    })
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

    const dockerfileSha256 = await sha256(join(source, pin.dockerfile))
    const lockfileSha256 = await sha256(join(source, pin.lockfile))
    const dockerfile = await readFile(join(source, pin.dockerfile), 'utf8')
    const baseTags = [
      ...dockerfile.matchAll(/^FROM\s+([^\s]+)(?:\s+AS\s+[^\s]+)?/gim),
    ]
      .map((match) => match[1])
      .filter(
        (tag) =>
          !tag.startsWith('$') &&
          !tag.includes('base') &&
          !tag.includes('build'),
      )
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
      baseImages,
      buildExitCode: 0,
    }
  } finally {
    await rm(acquisition, { recursive: true, force: true })
  }
}
