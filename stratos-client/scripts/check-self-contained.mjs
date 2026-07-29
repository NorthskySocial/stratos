// Guards that the published dist/ is self-contained.
//
// stratos-client ships to browsers. stratos-core (its former sibling for
// enrollment discovery) drags in drizzle-orm, postgres, @libsql/client, and
// zod for its server-side persistence layer. If anything under src/ imports
// from stratos-core, that whole dependency tree lands in the install of
// every downstream consumer of this package — including browser bundles.
// This script fails the build if that ever happens again.
//
// Run with: node scripts/check-self-contained.mjs

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
const distDir = resolve(packageRoot, 'dist')
const packageJsonPath = resolve(packageRoot, 'package.json')

const BANNED = '@northskysocial/stratos-core'

function collectFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    if (statSync(fullPath).isDirectory()) {
      found.push(...collectFiles(fullPath))
    } else {
      found.push(fullPath)
    }
  }
  return found
}

if (!existsSync(distDir)) {
  console.error(
    `error: ${relative(packageRoot, distDir)} does not exist — run the build first.`,
  )
  process.exit(1)
}

const violations = []
const files = collectFiles(distDir)

for (const file of files) {
  const content = readFileSync(file, 'utf-8')
  const lines = content.split('\n')
  lines.forEach((line, i) => {
    if (line.includes(BANNED)) {
      violations.push({
        location: `${relative(packageRoot, file)}:${i + 1}`,
        line: line.trim(),
      })
    }
  })
}

const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
for (const field of [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
]) {
  if (pkg[field] && BANNED in pkg[field]) {
    violations.push({
      location: `package.json:${field}`,
      line: `"${BANNED}": "${pkg[field][BANNED]}"`,
    })
  }
}

if (violations.length > 0) {
  console.error(`found ${violations.length} reference(s) to ${BANNED}:\n`)
  for (const { location, line } of violations) {
    console.error(`${location}: ${line}`)
  }
  console.error(
    `\nPort the code into stratos-client/src/ instead of importing from stratos-core. See src/discovery.ts for the pattern.`,
  )
  process.exit(1)
}

console.log(
  `ok: no references to ${BANNED} in dist/ or package.json (${files.length} files scanned)`,
)
