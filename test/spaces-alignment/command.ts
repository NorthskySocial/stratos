import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export interface CommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
}

export class CommandFailure extends Error {
  constructor(readonly code: number | string | undefined) {
    super('Child process failed')
  }
}

export async function executeCommand(
  file: string,
  args: string[],
  options: CommandOptions = {},
): Promise<string> {
  try {
    const { stdout } = await exec(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: options.timeout ?? 45 * 60_000,
    })
    return stdout
  } catch (error) {
    throw new CommandFailure((error as { code?: number | string }).code)
  }
}

export async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}
