import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const OWNER_FILE = 'owner'

export class WriterLockHeldError extends Error {
  constructor() {
    super('Feedgen writer lock is already held; operator recovery is required')
    this.name = 'WriterLockHeldError'
  }
}

export class WriterLockOwnershipLostError extends Error {
  constructor() {
    super('Feedgen writer lock ownership was lost')
    this.name = 'WriterLockOwnershipLostError'
  }
}

export interface WriterLock {
  release: () => Promise<void>
}

/** Acquires a crash-sticky writer lock that never permits automatic takeover. */
export async function acquireWriterLock(path: string): Promise<WriterLock> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') {
      throw new WriterLockHeldError()
    }
    throw error
  }

  const ownerPath = join(path, OWNER_FILE)
  const owner = randomUUID()
  try {
    await writeFile(ownerPath, owner, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    await rmdir(path).catch(() => undefined)
    throw error
  }

  let released = false
  return {
    async release(): Promise<void> {
      if (released) return
      if ((await readFile(ownerPath, 'utf8')) !== owner) {
        throw new WriterLockOwnershipLostError()
      }
      await rm(ownerPath)
      await rmdir(path)
      released = true
    },
  }
}
