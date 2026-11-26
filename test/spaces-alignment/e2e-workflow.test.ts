/**
 * On a pull request the sandbox workflow runs its `aiab` job only when the
 * gate's path filter selects a changed file. A change to anything the job
 * checks must therefore be selected, or a pull request that breaks only that
 * input skips the job.
 */
import { readFileSync } from 'node:fs'
import { dirname, matchesGlob, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKFLOW = readFileSync(
  resolve(HERE, '../../.github/workflows/e2e.yml'),
  'utf8',
)

function gateFilters(): string[] {
  const start = WORKFLOW.indexOf('relevant:\n')
  const end = WORKFLOW.indexOf('\n  aiab:')
  expect(start, 'the gate filter').toBeGreaterThan(0)
  expect(end, 'the aiab job').toBeGreaterThan(start)
  return [...WORKFLOW.slice(start, end).matchAll(/^\s+- '([^']+)'$/gm)].map(
    (match) => match[1],
  )
}

function selected(path: string): boolean {
  return gateFilters().some((filter) => matchesGlob(path, filter))
}

// The directory the job runs `deno check` in.
function denoScriptsDirectory(): string {
  const step = /working-directory: (\S+)\n\s+run: \|\n\s+deno check /.exec(
    WORKFLOW,
  )
  expect(step, 'the Deno check step').not.toBeNull()
  return step![1]
}

describe('the sandbox workflow gate', () => {
  it('reads a filter of its own', () => {
    expect(gateFilters()).toContain('stratos-*/**')
    expect(selected('stratos-service/src/index.ts')).toBe(true)
    expect(selected('README.md')).toBe(false)
  })

  it('runs the job when only the Deno scripts, their config or their lock change', () => {
    const scripts = denoScriptsDirectory()
    expect(scripts).toBe('test/scripts')
    for (const path of [
      `${scripts}/run-all.ts`,
      `${scripts}/lib/mixed-mode-pds.ts`,
      `${scripts}/deno.json`,
      `${scripts}/deno.lock`,
      // Deno reads the root workspace config to decide whether the scripts
      // belong to it.
      'deno.json',
    ]) {
      expect(selected(path), path).toBe(true)
    }
  })
})
