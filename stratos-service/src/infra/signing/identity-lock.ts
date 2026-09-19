import { execFileSync } from 'node:child_process'
import { open, type FileHandle } from 'node:fs/promises'

/** Keep the inode: unlinking a lock file permits two owners of different inodes. */
export async function acquireIdentityLock(file: string): Promise<FileHandle> {
  const handle = await open(file, 'a+', 0o600)
  try {
    // flock locks the inherited open file description. After the helper exits,
    // our descriptor retains ownership until close or process death.
    execFileSync('flock', ['--exclusive', '--nonblock', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', handle.fd],
    })
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}
