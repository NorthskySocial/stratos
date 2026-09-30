import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}
