// Guards that the published dist/ exports the full public surface.
//
// Version 0.4.0 shipped without attestation.js and five other exports. The
// build was green, because nothing compared the built surface against the
// surface that consumers import. A downstream install then failed to compile.
// This script fails the build if an expected export ever disappears again.
//
// Add a name here when you add an export to src/index.ts.
//
// Run with: node scripts/check-exports.mjs

import { readFileSync, existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
const distDir = resolve(packageRoot, 'dist')
const entryPath = resolve(distDir, 'index.d.ts')

const EXPECTED_EXPORTS = [
  // types
  'FetchHandler',
  'FetchHandlerObject',
  'FetchAndVerifyOptions',
  'ResolveSigningKeyOptions',
  'ServiceAttestation',
  'StratosEnrollment',
  'StratosScopes',
  'VerificationLevel',
  'VerifiedRecord',
  // discovery
  'ENROLLMENT_COLLECTION',
  'discoverEnrollment',
  'discoverEnrollments',
  'getEnrollmentByServiceDid',
  'parseEnrollmentRecord',
  // routing
  'createServiceFetchHandler',
  'resolveServiceUrl',
  'findEnrollmentByService',
  'serviceDIDToRkey',
  'ServiceFetchHandlerOptions',
  // verification
  'verifyCidIntegrity',
  'verifyRecordCid',
  'resolveServiceSigningKey',
  'resolveUserSigningKey',
  'fetchAndVerifyRecord',
  'verifyStratosRecord',
  // attestation
  'verifyEnrollmentAttestation',
  'AttestationResult',
  // scopes
  'STRATOS_SCOPES',
  'buildCollectionScope',
  'buildRpcScope',
  'buildStratosScopes',
]

const EXPECTED_MODULES = [
  'attestation.js',
  'discovery.js',
  'lexicons.js',
  'routing.js',
  'scopes.js',
  'types.js',
  'verification.js',
]

if (!existsSync(entryPath)) {
  console.error(
    `error: ${relative(packageRoot, entryPath)} does not exist — run the build first.`,
  )
  process.exit(1)
}

const entry = readFileSync(entryPath, 'utf-8')

const missingExports = EXPECTED_EXPORTS.filter(
  (name) => !new RegExp(`\\b${name}\\b`).test(entry),
)

const missingModules = EXPECTED_MODULES.filter(
  (file) => !existsSync(resolve(distDir, file)),
)

if (missingExports.length > 0 || missingModules.length > 0) {
  if (missingExports.length > 0) {
    console.error(
      `missing ${missingExports.length} export(s) from dist/index.d.ts:\n`,
    )
    for (const name of missingExports) console.error(`  ${name}`)
    console.error('')
  }
  if (missingModules.length > 0) {
    console.error(`missing ${missingModules.length} module(s) from dist/:\n`)
    for (const file of missingModules) console.error(`  ${file}`)
    console.error('')
  }
  console.error(
    'Export the missing name from src/index.ts, or update EXPECTED_EXPORTS\n' +
      'in this script when you remove an export on purpose.',
  )
  process.exit(1)
}

console.log(
  `ok: dist/index.d.ts exports all ${EXPECTED_EXPORTS.length} expected names ` +
    `(${EXPECTED_MODULES.length} modules present)`,
)
