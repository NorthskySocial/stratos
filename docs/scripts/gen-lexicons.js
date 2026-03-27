#!/usr/bin/env node
/**
 * Crawls stratos/lexicons/ and reports all discovered lexicons.
 * The actual build-time generation is handled by lexicons/lexicons.data.js (VitePress data loader).
 * This script is useful for validation and CI reporting.
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LEXICONS_DIR = resolve(__dirname, '../../lexicons')

function walkJson(dir) {
  const results = []
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry)
    if (statSync(full).isDirectory()) {
      results.push(...walkJson(full))
    } else if (entry.endsWith('.json')) {
      results.push(full)
    }
  }
  return results
}

const files = walkJson(LEXICONS_DIR)
let errors = 0

const byNs = {}

for (const file of files) {
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`✗ Parse error: ${file}\n  ${e.message}`)
    errors++
    continue
  }

  if (!raw.id) {
    console.error(`✗ Missing 'id': ${file}`)
    errors++
    continue
  }

  if (!raw.defs) {
    console.error(`✗ Missing 'defs': ${raw.id}`)
    errors++
    continue
  }

  const type = raw.defs.main?.type ?? 'defs'
  const parts = raw.id.split('.')
  const ns = parts.length >= 4 ? parts[2] : 'core'

  if (!byNs[ns]) byNs[ns] = []
  byNs[ns].push({ id: raw.id, type })
}

const TYPE_ICONS = {
  query: '🔵',
  procedure: '🟣',
  subscription: '🟡',
  record: '🟢',
  defs: '⚪',
}

console.log(`\nStratos Lexicons — ${files.length} file(s) found\n`)
for (const [ns, entries] of Object.entries(byNs).sort()) {
  console.log(`  ${ns.toUpperCase()}`)
  for (const { id, type } of entries) {
    console.log(`    ${TYPE_ICONS[type] ?? '•'} ${id}  [${type}]`)
  }
  console.log()
}

if (errors) {
  console.error(`\n${errors} error(s) found.\n`)
  process.exit(1)
} else {
  console.log(`✓ All lexicons valid.\n`)
}
