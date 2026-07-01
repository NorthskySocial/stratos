import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * SWP-11 confinement guard.
 *
 * Raw per-actor private key material must never leave `infra/signing/`. The
 * only APIs that hand back a `Keypair` carrying private material are the actor
 * key-store's `loadSigningKey` / `createSigningKey`. This test statically scans
 * `src/` and fails if any file OUTSIDE the signer module references those
 * methods, catching regressions that would re-leak key material.
 *
 * (Access is via property calls — `ctx.actorStore.loadSigningKey(...)` — not
 * imports, so an ESLint `no-restricted-imports` rule cannot see it; a source
 * scan is the right mechanism.)
 */

// Methods that return a per-actor Keypair (private key material).
const FORBIDDEN_KEYSTORE_METHODS = ['loadSigningKey', 'createSigningKey']

// The only directory permitted to touch that key material.
const ALLOWED_DIR = join('infra', 'signing')

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url))

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full))
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

function isAllowed(file: string): boolean {
  const rel = relative(SRC_DIR, file)
  return rel.split(sep).join('/').startsWith(ALLOWED_DIR.split(sep).join('/'))
}

describe('per-actor key material confinement', () => {
  it('no code outside infra/signing/ accesses the private-key key-store methods', () => {
    const offenders: string[] = []

    for (const file of walk(SRC_DIR)) {
      if (isAllowed(file)) continue
      const source = readFileSync(file, 'utf8')
      for (const method of FORBIDDEN_KEYSTORE_METHODS) {
        // Match `.loadSigningKey`/`.createSigningKey` member access.
        const re = new RegExp(`\\.${method}\\b`)
        if (re.test(source)) {
          offenders.push(`${relative(SRC_DIR, file)} references .${method}`)
        }
      }
    }

    expect(
      offenders,
      `Private-key key-store access leaked outside infra/signing/:\n` +
        offenders.join('\n'),
    ).toEqual([])
  })
})
