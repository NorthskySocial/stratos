import { createHash } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  lstat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

export interface BlobCache {
  get: (key: string) => Promise<Buffer | undefined>
  put: (key: string, bytes: Buffer) => Promise<void>
  remove: (key: string) => Promise<void>
}

export interface DiskBlobCacheOptions {
  directory: string
  maxBytes: number
  ttlMs: number
  now?: () => number
}

interface Entry {
  size: number
  expiresAt: number
}

export function blobCacheKey(did: string, cid: string): string {
  return createHash('sha256').update(`${did}\n${cid}`).digest('hex')
}

export class DiskBlobCache implements BlobCache {
  private readonly entries = new Map<string, Entry>()
  private totalBytes = 0
  private tail = Promise.resolve()
  private readonly now: () => number

  private constructor(private readonly options: DiskBlobCacheOptions) {
    this.now = options.now ?? Date.now
  }

  static async open(options: DiskBlobCacheOptions): Promise<DiskBlobCache> {
    const cache = new DiskBlobCache(options)
    await mkdir(options.directory, { recursive: true, mode: 0o700 })
    for (const name of await readdir(options.directory)) {
      if (/^[a-f0-9]{64}\.tmp$/.test(name)) {
        await rm(join(options.directory, name))
        continue
      }
      if (!/^[a-f0-9]{64}$/.test(name)) continue
      const info = await lstat(join(options.directory, name))
      const expiresAt = info.mtimeMs + options.ttlMs
      if (!info.isFile() || expiresAt <= cache.now()) {
        await rm(join(options.directory, name))
      } else {
        cache.entries.set(name, { size: info.size, expiresAt })
        cache.totalBytes += info.size
      }
    }
    await cache.makeRoom(0)
    return cache
  }

  get(key: string): Promise<Buffer | undefined> {
    return this.serialize(async () => {
      const entry = this.entries.get(key)
      if (!entry) return undefined
      if (entry.expiresAt <= this.now()) {
        await this.removeEntry(key)
        return undefined
      }
      let bytes: Buffer
      try {
        bytes = await readFile(join(this.options.directory, key))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await this.removeEntry(key)
        return undefined
      }
      this.entries.delete(key)
      this.entries.set(key, entry)
      return bytes
    })
  }

  put(key: string, bytes: Buffer): Promise<void> {
    return this.serialize(async () => {
      if (bytes.length > this.options.maxBytes) return
      await this.removeEntry(key)
      await this.makeRoom(bytes.length)
      const location = join(this.options.directory, key)
      await writeFile(`${location}.tmp`, bytes, { mode: 0o600 })
      await rename(`${location}.tmp`, location)
      this.entries.set(key, {
        size: bytes.length,
        expiresAt: this.now() + this.options.ttlMs,
      })
      this.totalBytes += bytes.length
    })
  }

  remove(key: string): Promise<void> {
    return this.serialize(() => this.removeEntry(key))
  }

  private async makeRoom(size: number): Promise<void> {
    for (const key of this.entries.keys()) {
      if (this.totalBytes + size <= this.options.maxBytes) break
      await this.removeEntry(key)
    }
  }

  private async removeEntry(key: string): Promise<void> {
    const entry = this.entries.get(key)
    if (!entry) return
    await rm(join(this.options.directory, key), { force: true })
    this.entries.delete(key)
    this.totalBytes -= entry.size
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.then(
      () => {},
      () => {},
    )
    return result
  }
}
