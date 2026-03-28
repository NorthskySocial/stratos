import { readdirSync, readFileSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve, relative } from 'path'

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

function extractType(lexicon) {
  return lexicon.defs?.main?.type ?? 'defs'
}

function extractNamespace(id) {
  const parts = id.split('.')
  // zone.stratos.{namespace}.{name} → return namespace segment
  // zone.stratos.defs (top-level) → return 'core'
  if (parts.length === 3) return 'core'
  return parts[2]
}

export default {
  load() {
    const files = walkJson(LEXICONS_DIR)
    const byNamespace = {}

    for (const file of files) {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const id = raw.id
      const ns = extractNamespace(id)

      if (!byNamespace[ns]) byNamespace[ns] = []

      byNamespace[ns].push({
        id,
        type: extractType(raw),
        description: raw.defs?.main?.description ?? '',
        mainDef: raw.defs?.main ?? null,
        allDefs: raw.defs ?? {},
      })
    }

    // Sort lexicons within each namespace by ID
    for (const ns of Object.keys(byNamespace)) {
      byNamespace[ns].sort((a, b) => a.id.localeCompare(b.id))
    }

    const namespaceOrder = [
      'core',
      'actor',
      'boundary',
      'enrollment',
      'feed',
      'identity',
      'repo',
      'server',
      'sync',
    ]
    const namespaces = namespaceOrder
      .filter((ns) => byNamespace[ns])
      .map((ns) => ({ name: ns, lexicons: byNamespace[ns] }))

    // Append any namespaces not in the explicit order
    for (const ns of Object.keys(byNamespace)) {
      if (!namespaceOrder.includes(ns)) {
        namespaces.push({ name: ns, lexicons: byNamespace[ns] })
      }
    }

    return { namespaces }
  },
}
