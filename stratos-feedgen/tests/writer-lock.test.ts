import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireWriterLock,
  WriterLockHeldError,
  WriterLockOwnershipLostError,
} from '../src/lifecycle/writer-lock.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function lockPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'feedgen-writer-lock-'))
  directories.push(directory)
  return join(directory, 'writer.lock')
}

describe('writer lock', () => {
  it('permits one writer and releases only its own lock', async () => {
    const path = await lockPath()
    const first = await acquireWriterLock(path)

    await expect(acquireWriterLock(path)).rejects.toThrow(
      'Feedgen writer lock is already held; operator recovery is required',
    )
    try {
      await acquireWriterLock(path)
    } catch (error) {
      expect(error).toBeInstanceOf(WriterLockHeldError)
      expect((error as Error).name).toBe('WriterLockHeldError')
    }
    expect((await stat(path)).mode & 0o077).toBe(0)
    expect((await stat(join(path, 'owner'))).mode & 0o077).toBe(0)

    await first.release()
    await first.release()

    const second = await acquireWriterLock(path)
    await second.release()
  })

  it('does not automatically take over a crash-sticky lock', async () => {
    const path = await lockPath()
    await mkdir(path, { mode: 0o700 })

    await expect(acquireWriterLock(path)).rejects.toBeInstanceOf(
      WriterLockHeldError,
    )
  })

  it('does not misreport a missing lock parent as an existing writer', async () => {
    const path = join(await lockPath(), 'missing', 'writer.lock')

    await expect(acquireWriterLock(path)).rejects.not.toBeInstanceOf(
      WriterLockHeldError,
    )
  })

  it('refuses to release a lock whose owner changed', async () => {
    const path = await lockPath()
    const lock = await acquireWriterLock(path)
    await writeFile(join(path, 'owner'), 'replacement-owner', 'utf8')

    await expect(lock.release()).rejects.toThrow(
      'Feedgen writer lock ownership was lost',
    )
    try {
      await lock.release()
    } catch (error) {
      expect(error).toBeInstanceOf(WriterLockOwnershipLostError)
      expect((error as Error).name).toBe('WriterLockOwnershipLostError')
    }
  })
})
