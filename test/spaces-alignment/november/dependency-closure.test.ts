import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  SPACE_TYPE,
  buildSpaceScope,
} from '../../../stratos-service/src/oauth/client.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const SERVICE_PACKAGE_JSON = resolve(REPO_ROOT, 'stratos-service/package.json')
const LOCKFILE = resolve(REPO_ROOT, 'pnpm-lock.yaml')
const SCOPES_PACKAGE = '@atproto/oauth-scopes'
const RETIRED_SCOPES_VERSION = '0.0.0-spaces-alpha-20260818163953'
const UNPUBLISHED_STAGE_MARKER = '0.0.0-stage'
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

const HOSTED_COLLECTIONS = [
  'zone.stratos.feed.post',
  'app.bsky.feed.like',
  'app.bsky.feed.repost',
]
const SERVICE_DID_WITH_PORT = 'did:web:nerv.tokyo.jp%3A3100'
const OTHER_AUTHORITY = 'did:web:seele.tokyo.jp'

interface PackageJson {
  name: string
  version: string
  dependencies?: Record<string, string>
}

interface ScopePermissionsApi {
  allowsSpace(
    target: { spaceType: string; authority: string; skey: string },
    operation: { action: string; collection?: string },
  ): boolean
}

interface SpacePermissionApi {
  spaceType: string
  collection: readonly string[] | undefined
}

interface ScopesModule {
  ScopePermissions: new (scope: string) => ScopePermissionsApi
  SpacePermission: {
    fromString(scope: string): SpacePermissionApi | null
  }
}

function packageRootOf(entryPath: string): string {
  let directory = dirname(entryPath)
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory)
    if (parent === directory)
      throw new Error(`no package.json above ${entryPath}`)
    directory = parent
  }
  return directory
}

function readPackageJson(root: string): PackageJson {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
}

// Resolution starts at the service so a dependency hoisted to the repository
// root cannot stand in for the one the service actually installs.
const serviceRequire = createRequire(SERVICE_PACKAGE_JSON)
const scopesEntry = serviceRequire.resolve(SCOPES_PACKAGE)
const scopesRoot = packageRootOf(scopesEntry)
const scopesPackage = readPackageJson(scopesRoot)

function sourcesEntry(): { version: string; selection: string } {
  const manifest = JSON.parse(
    readFileSync(resolve(HERE, 'sources.json'), 'utf8'),
  ) as { packages: Array<{ name: string; version: string; selection: string }> }
  const entry = manifest.packages.find((pkg) => pkg.name === SCOPES_PACKAGE)
  if (entry === undefined) throw new Error(`${SCOPES_PACKAGE} not in manifest`)
  return entry
}

async function loadScopes(): Promise<ScopesModule> {
  return (await import(pathToFileURL(scopesEntry).href)) as ScopesModule
}

describe('selected oauth-scopes closure', () => {
  it('resolves through the service to the version the manifest selects', () => {
    const entry = sourcesEntry()
    expect(scopesPackage.version).toBe(entry.version)
    expect(entry.selection).toBe('selected')
  })

  it('exports the permission classes the service uses', async () => {
    const scopes = await loadScopes()
    expect(typeof scopes.ScopePermissions).toBe('function')
    expect(typeof scopes.SpacePermission?.fromString).toBe('function')
  })

  it('reads the scope the service requests as its space type and collections', async () => {
    const { SpacePermission } = await loadScopes()
    const permission = SpacePermission.fromString(
      buildSpaceScope(SERVICE_DID_WITH_PORT),
    )
    expect(permission?.spaceType).toBe('zone.stratos.space.feed')
    expect(permission?.spaceType).toBe(SPACE_TYPE)
    expect([...(permission?.collection ?? [])].sort()).toEqual(
      [...HOSTED_COLLECTIONS].sort(),
    )
  })

  it('answers the two-argument form per collection and authority', async () => {
    const { ScopePermissions } = await loadScopes()
    const grant = new ScopePermissions(buildSpaceScope(SERVICE_DID_WITH_PORT))
    const space = (authority: string) => ({
      spaceType: SPACE_TYPE,
      authority,
      skey: '*',
    })
    for (const collection of HOSTED_COLLECTIONS) {
      expect(
        grant.allowsSpace(space(SERVICE_DID_WITH_PORT), {
          action: 'create',
          collection,
        }),
        collection,
      ).toBe(true)
    }
    expect(
      grant.allowsSpace(space(SERVICE_DID_WITH_PORT), {
        action: 'create',
        collection: 'app.bsky.feed.generator',
      }),
    ).toBe(false)
    expect(
      grant.allowsSpace(space(OTHER_AUTHORITY), {
        action: 'create',
        collection: 'zone.stratos.feed.post',
      }),
    ).toBe(false)
  })

  it('installs every dependency of the selected package at an exact, published version', async () => {
    const declared = scopesPackage.dependencies ?? {}
    expect(Object.keys(declared).length).toBeGreaterThan(0)
    const scopesRequire = createRequire(join(scopesRoot, 'package.json'))
    for (const [name, range] of Object.entries(declared)) {
      expect(range, `${name} range`).toMatch(EXACT_VERSION)
      expect(range, `${name} range`).not.toContain(UNPUBLISHED_STAGE_MARKER)
      const entry = scopesRequire.resolve(name)
      const installed = readPackageJson(packageRootOf(entry))
      expect(installed.version, `${name} installed`).toBe(range)
      const loaded = (await import(pathToFileURL(entry).href)) as object
      expect(Object.keys(loaded).length, `${name} exports`).toBeGreaterThan(0)
    }
  })
})

describe('lockfile closure', () => {
  const lockfile = readFileSync(LOCKFILE, 'utf8')

  it('holds no unpublished stage package', () => {
    expect(
      lockfile.includes(UNPUBLISHED_STAGE_MARKER),
      'stage marker in lockfile',
    ).toBe(false)
  })

  it('no longer resolves the retired oauth-scopes build', () => {
    const retired = `${SCOPES_PACKAGE}@${RETIRED_SCOPES_VERSION}`
    expect(lockfile.includes(retired), `${retired} in lockfile`).toBe(false)
  })

  it('resolves the selected oauth-scopes build with an integrity hash', () => {
    const { version } = sourcesEntry()
    const header = `'${SCOPES_PACKAGE}@${version}':`
    const start = lockfile.indexOf(header)
    expect(start, `${header} entry`).toBeGreaterThanOrEqual(0)
    const entry = lockfile.slice(start, start + 400)
    expect(entry).toMatch(/integrity: sha512-/)
  })
})
