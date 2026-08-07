import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from '../src/db'
import { SqliteAdminSessionStore } from '../src/oauth/admin-session-store.js'
import {
  isEffectiveAdmin,
  SqliteAdminUserStore,
  type AdminUserStore,
} from '../src/oauth/admin-user-store.js'
import {
  ADMIN_SESSION_COOKIE,
  resolveAdminSession,
} from '../src/oauth/admin-routes.js'
import { handleAdminCallback } from '../src/oauth/handlers/admin-callback.js'
import { createAuthVerifiers } from '../src/infra/auth/verifiers.js'
import {
  envToConfig,
  isAllowedCredentialedOrigin,
  isAllowedRedirectOrigin,
  parseEnv,
  passesAdminCsrfCheck,
} from '../src/config.js'
import { createTestConfig } from './utils'

const ADMIN_DID = 'did:plc:usagi'
const INTRUDER_DID = 'did:plc:mamoru'
const PUBLIC_URL = 'https://stratos.test'

/** Store stub for cases that exercise the config allowlist alone. */
const NO_GRANTED_ADMINS = {
  has: async () => false,
} as unknown as AdminUserStore

function grantedAdminStore(granted: string): AdminUserStore {
  return {
    has: async (did: string) => did === granted,
  } as unknown as AdminUserStore
}

function makeAdminCtx(headers: Record<string, string | undefined>): {
  req: import('node:http').IncomingMessage
  res: import('node:http').ServerResponse
} {
  return {
    req: { headers } as unknown as import('node:http').IncomingMessage,
    res: {
      setHeader: vi.fn(),
    } as unknown as import('node:http').ServerResponse,
  }
}

describe('SqliteAdminSessionStore', () => {
  let dataDir: string
  let db: ServiceDb
  let store: SqliteAdminSessionStore

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-admin-session-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)
    store = new SqliteAdminSessionStore(db)
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  it('issues an opaque key and reads the session back', async () => {
    const key = await store.create(ADMIN_DID, 60_000)
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/)

    const session = await store.get(key)
    expect(session?.did).toBe(ADMIN_DID)
    expect(Date.parse(session!.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('mints a distinct key per session', async () => {
    const a = await store.create(ADMIN_DID, 60_000)
    const b = await store.create(ADMIN_DID, 60_000)
    expect(a).not.toBe(b)
  })

  it('returns undefined for an unknown key', async () => {
    expect(await store.get('does-not-exist')).toBeUndefined()
  })

  it('treats an expired session as absent and purges it', async () => {
    const key = await store.create(ADMIN_DID, -1_000)
    expect(await store.get(key)).toBeUndefined()
    // A second read confirms the expired row was deleted, not just filtered.
    expect(await store.get(key)).toBeUndefined()
  })

  it('deletes a session on logout', async () => {
    const key = await store.create(ADMIN_DID, 60_000)
    await store.del(key)
    expect(await store.get(key)).toBeUndefined()
  })

  it('sweeps only expired sessions, leaving live ones intact', async () => {
    const expired = await store.create(ADMIN_DID, -1_000)
    const live = await store.create(ADMIN_DID, 60_000)

    const removed = await store.deleteExpired()

    expect(removed).toBe(1)
    expect(await store.get(live)).toBeDefined()
    // The expired row is gone; a direct del would have been a no-op.
    const req: any = {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${expired}` },
    }
    const did = await resolveAdminSession(req, {
      adminSessionStore: store,
      adminDids: [ADMIN_DID],
      adminUserStore: NO_GRANTED_ADMINS,
    })
    expect(did).toBeNull()
  })

  it('sweeps nothing when all sessions are live', async () => {
    await store.create(ADMIN_DID, 60_000)
    await store.create(ADMIN_DID, 60_000)
    expect(await store.deleteExpired()).toBe(0)
  })
})

describe('isAllowedCredentialedOrigin', () => {
  it('admits the service origin', () => {
    expect(
      isAllowedCredentialedOrigin(PUBLIC_URL, {
        publicUrl: PUBLIC_URL,
        devMode: false,
      }),
    ).toBe(true)
  })

  it('rejects a foreign origin', () => {
    expect(
      isAllowedCredentialedOrigin('https://gehirn.tokyo.jp', {
        publicUrl: PUBLIC_URL,
        devMode: false,
      }),
    ).toBe(false)
  })

  it('rejects a missing origin', () => {
    expect(
      isAllowedCredentialedOrigin(undefined, {
        publicUrl: PUBLIC_URL,
        devMode: false,
      }),
    ).toBe(false)
  })

  it('admits localhost only in dev mode', () => {
    expect(
      isAllowedCredentialedOrigin('http://localhost:5173', {
        publicUrl: PUBLIC_URL,
        devMode: true,
      }),
    ).toBe(true)
    expect(
      isAllowedCredentialedOrigin('http://localhost:5173', {
        publicUrl: PUBLIC_URL,
        devMode: false,
      }),
    ).toBe(false)
  })
})

describe('isAllowedRedirectOrigin', () => {
  const WEBAPP_ORIGIN = 'https://nerv.tokyo.jp'

  it('admits an allow-listed origin', () => {
    expect(
      isAllowedRedirectOrigin(`${WEBAPP_ORIGIN}/enrolled?x=1`, {
        allowedRedirectOrigins: [WEBAPP_ORIGIN],
        devMode: false,
      }),
    ).toBe(true)
  })

  it('rejects a foreign origin', () => {
    expect(
      isAllowedRedirectOrigin('https://seele.example/phish', {
        allowedRedirectOrigins: [WEBAPP_ORIGIN],
        devMode: false,
      }),
    ).toBe(false)
  })

  it('rejects a malformed redirect uri', () => {
    expect(
      isAllowedRedirectOrigin('not a url', {
        allowedRedirectOrigins: [WEBAPP_ORIGIN],
        devMode: false,
      }),
    ).toBe(false)
  })

  it('admits loopback only in dev mode', () => {
    for (const uri of [
      'http://localhost:5173/',
      'http://127.0.0.1:5173/',
      'http://[::1]:5173/',
    ]) {
      expect(
        isAllowedRedirectOrigin(uri, {
          allowedRedirectOrigins: [],
          devMode: true,
        }),
      ).toBe(true)
      expect(
        isAllowedRedirectOrigin(uri, {
          allowedRedirectOrigins: [],
          devMode: false,
        }),
      ).toBe(false)
    }
  })

  it('rejects everything when the allow-list is empty and not dev', () => {
    for (const uri of [
      `${WEBAPP_ORIGIN}/`,
      'https://seele.example/phish',
      'https://stratos.test/',
    ]) {
      expect(
        isAllowedRedirectOrigin(uri, {
          allowedRedirectOrigins: [],
          devMode: false,
        }),
      ).toBe(false)
    }
  })

  it('matches on origin, not on a path or host prefix', () => {
    expect(
      isAllowedRedirectOrigin('https://nerv.tokyo.jp.seele.example/', {
        allowedRedirectOrigins: [WEBAPP_ORIGIN],
        devMode: false,
      }),
    ).toBe(false)
    expect(
      isAllowedRedirectOrigin('https://nerv.tokyo.jp:8443/', {
        allowedRedirectOrigins: [WEBAPP_ORIGIN],
        devMode: false,
      }),
    ).toBe(false)
  })

  it('never admits an opaque origin, even with a literal null entry', () => {
    expect(
      isAllowedRedirectOrigin('data:text/html,x', {
        allowedRedirectOrigins: ['null'],
        devMode: false,
      }),
    ).toBe(false)
  })

  describe('allow-list entry normalization (env parse path)', () => {
    let saved: NodeJS.ProcessEnv

    beforeEach(() => {
      saved = { ...process.env }
    })
    afterEach(() => {
      process.env = saved
    })

    function configWithAllowList(entries: string) {
      process.env = {
        STRATOS_SERVICE_DID: 'did:web:stratos.test',
        STRATOS_PUBLIC_URL: PUBLIC_URL,
        STRATOS_ALLOWED_DOMAINS: 'general',
        STRATOS_ALLOWED_REDIRECT_ORIGINS: entries,
      } as NodeJS.ProcessEnv
      return envToConfig(parseEnv())
    }

    it.each([
      ['trailing slash', 'https://app.example/'],
      ['explicit default port', 'https://app.example:443'],
      ['uppercase', 'HTTPS://App.Example'],
    ])('normalizes a %s entry to its origin', (_label, entry) => {
      const config = configWithAllowList(entry)
      expect(
        isAllowedRedirectOrigin('https://app.example/path', {
          allowedRedirectOrigins: config.allowedRedirectOrigins,
          devMode: false,
        }),
      ).toBe(true)
    })

    it('fails config loading on a malformed entry', () => {
      expect(() => configWithAllowList('not a url')).toThrow(
        /STRATOS_ALLOWED_REDIRECT_ORIGINS entry "not a url"/,
      )
    })
  })
})

describe('passesAdminCsrfCheck', () => {
  const deps = { publicUrl: PUBLIC_URL, devMode: false }
  const makeReq = (headers: Record<string, string>) =>
    ({ headers }) as unknown as import('node:http').IncomingMessage

  it('admits a request whose Origin is the service origin', () => {
    expect(passesAdminCsrfCheck(makeReq({ origin: PUBLIC_URL }), deps)).toBe(
      true,
    )
  })

  it('rejects a request with a foreign Origin', () => {
    expect(
      passesAdminCsrfCheck(
        makeReq({ origin: 'https://gehirn.tokyo.jp' }),
        deps,
      ),
    ).toBe(false)
  })

  it('falls back to Referer when no Origin is present', () => {
    expect(
      passesAdminCsrfCheck(makeReq({ referer: `${PUBLIC_URL}/admin` }), deps),
    ).toBe(true)
    expect(
      passesAdminCsrfCheck(
        makeReq({ referer: 'https://gehirn.tokyo.jp/admin' }),
        deps,
      ),
    ).toBe(false)
  })

  // A browser cross-site POST always carries an Origin, so the no-header case
  // cannot be a browser-driven forgery; the SameSite=Strict cookie is the gate.
  // This passes through intentionally so same-origin server-to-server admin
  // tooling (the E2E suite) is not blocked — guarding against a regression to
  // fail-closed behavior.
  it('admits a request with neither Origin nor Referer', () => {
    expect(passesAdminCsrfCheck(makeReq({}), deps)).toBe(true)
  })
})

describe('admin auth verifier', () => {
  let dataDir: string
  let db: ServiceDb
  let store: SqliteAdminSessionStore
  let adminUserStore: SqliteAdminUserStore
  let verifiers: ReturnType<typeof createAuthVerifiers>

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-admin-verifier-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)
    store = new SqliteAdminSessionStore(db)
    adminUserStore = new SqliteAdminUserStore(db)

    const cfg = createTestConfig(dataDir)
    cfg.service.publicUrl = PUBLIC_URL

    verifiers = createAuthVerifiers(
      cfg.service.did,
      {} as never,
      cfg,
      {} as never,
      store,
      adminUserStore,
      [ADMIN_DID],
      {} as never,
      undefined,
      false,
      // signingKey — the space-credential path is not exercised here
      { did: () => cfg.service.did },
    )
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  it('accepts a valid session from the service origin', async () => {
    const key = await store.create(ADMIN_DID, 60_000)
    const result = await verifiers.admin(
      makeAdminCtx({
        origin: PUBLIC_URL,
        cookie: `${ADMIN_SESSION_COOKIE}=${key}`,
      }),
    )
    expect(result.credentials).toEqual({ type: 'admin', did: ADMIN_DID })
  })

  it('accepts an admin granted at runtime, not just configured ones', async () => {
    const grantedDid = 'did:plc:motokokusanagi'
    await adminUserStore.add(grantedDid, ADMIN_DID)
    const key = await store.create(grantedDid, 60_000)

    const result = await verifiers.admin(
      makeAdminCtx({
        origin: PUBLIC_URL,
        cookie: `${ADMIN_SESSION_COOKIE}=${key}`,
      }),
    )

    expect(result.credentials).toEqual({ type: 'admin', did: grantedDid })
  })

  it('rejects a session once its runtime grant is revoked', async () => {
    const grantedDid = 'did:plc:motokokusanagi'
    await adminUserStore.add(grantedDid, ADMIN_DID)
    await adminUserStore.remove(grantedDid)
    const key = await store.create(grantedDid, 60_000)

    await expect(
      verifiers.admin(
        makeAdminCtx({
          origin: PUBLIC_URL,
          cookie: `${ADMIN_SESSION_COOKIE}=${key}`,
        }),
      ),
    ).rejects.toThrow()
  })

  it('accepts a session when no Origin or Referer is present', async () => {
    const key = await store.create(ADMIN_DID, 60_000)
    const result = await verifiers.admin(
      makeAdminCtx({ cookie: `${ADMIN_SESSION_COOKIE}=${key}` }),
    )
    expect(result.credentials.did).toBe(ADMIN_DID)
  })

  it('rejects a cross-origin request before consulting the session', async () => {
    const key = await store.create(ADMIN_DID, 60_000)
    await expect(
      verifiers.admin(
        makeAdminCtx({
          origin: 'https://gehirn.tokyo.jp',
          cookie: `${ADMIN_SESSION_COOKIE}=${key}`,
        }),
      ),
    ).rejects.toThrow(/Cross-origin/)
  })

  it('rejects a request with no session cookie', async () => {
    await expect(
      verifiers.admin(makeAdminCtx({ origin: PUBLIC_URL })),
    ).rejects.toThrow(/Admin authorization required/)
  })

  it('rejects an expired session', async () => {
    const key = await store.create(ADMIN_DID, -1_000)
    await expect(
      verifiers.admin(
        makeAdminCtx({
          origin: PUBLIC_URL,
          cookie: `${ADMIN_SESSION_COOKIE}=${key}`,
        }),
      ),
    ).rejects.toThrow(/invalid or expired/)
  })

  it('rejects a session whose DID has fallen off the allowlist', async () => {
    const key = await store.create(INTRUDER_DID, 60_000)
    await expect(
      verifiers.admin(
        makeAdminCtx({
          origin: PUBLIC_URL,
          cookie: `${ADMIN_SESSION_COOKIE}=${key}`,
        }),
      ),
    ).rejects.toThrow(/Not an authorized admin/)
  })
})

describe('admin OAuth callback', () => {
  let dataDir: string
  let db: ServiceDb
  let store: SqliteAdminSessionStore
  let oauthClient: {
    callback: ReturnType<typeof vi.fn>
    revoke: ReturnType<typeof vi.fn>
  }

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-admin-callback-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)
    store = new SqliteAdminSessionStore(db)
    oauthClient = {
      callback: vi.fn(),
      revoke: vi.fn().mockResolvedValue(undefined),
    }
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  function makeConfig() {
    return {
      // The handler only touches callback/revoke from the OAuth client.
      oauthClient: oauthClient as never,
      adminSessionStore: store,
      adminDids: [ADMIN_DID],
      adminUserStore: NO_GRANTED_ADMINS,
      baseUrl: PUBLIC_URL,
    }
  }

  it('establishes a session cookie for an allowlisted DID', async () => {
    oauthClient.callback.mockResolvedValue({ session: { sub: ADMIN_DID } })
    const handler = handleAdminCallback(makeConfig())

    const req: any = { url: '/admin/oauth/callback?code=foo&state=bar' }
    const res: any = {
      cookie: vi.fn(),
      redirect: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await handler(req, res)

    expect(res.cookie).toHaveBeenCalledWith(
      ADMIN_SESSION_COOKIE,
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
      }),
    )
    expect(res.redirect).toHaveBeenCalledWith('/admin')

    const issuedKey = res.cookie.mock.calls[0][1]
    const session = await store.get(issuedKey)
    expect(session?.did).toBe(ADMIN_DID)
  })

  it('refuses a non-allowlisted DID and revokes its OAuth session', async () => {
    oauthClient.callback.mockResolvedValue({ session: { sub: INTRUDER_DID } })
    const createSpy = vi.spyOn(store, 'create')
    const handler = handleAdminCallback(makeConfig())

    const req: any = { url: '/admin/oauth/callback?code=foo&state=bar' }
    const res: any = {
      cookie: vi.fn(),
      redirect: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await handler(req, res)

    expect(oauthClient.revoke).toHaveBeenCalledWith(INTRUDER_DID)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.cookie).not.toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
  })
})

describe('resolveAdminSession (whoami / logout)', () => {
  let dataDir: string
  let db: ServiceDb
  let store: SqliteAdminSessionStore

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-admin-resolve-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)
    store = new SqliteAdminSessionStore(db)
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  it('returns the DID for a live, allowlisted session', async () => {
    const key = await store.create(ADMIN_DID, 60_000)
    const req: any = { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${key}` } }
    const did = await resolveAdminSession(req, {
      adminSessionStore: store,
      adminDids: [ADMIN_DID],
      adminUserStore: NO_GRANTED_ADMINS,
    })
    expect(did).toBe(ADMIN_DID)
  })

  it('returns null once the session is deleted (logout)', async () => {
    const key = await store.create(ADMIN_DID, 60_000)
    await store.del(key)
    const req: any = { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${key}` } }
    const did = await resolveAdminSession(req, {
      adminSessionStore: store,
      adminDids: [ADMIN_DID],
      adminUserStore: NO_GRANTED_ADMINS,
    })
    expect(did).toBeNull()
  })

  it('returns null when there is no session cookie', async () => {
    const req: any = { headers: {} }
    const did = await resolveAdminSession(req, {
      adminSessionStore: store,
      adminDids: [ADMIN_DID],
      adminUserStore: NO_GRANTED_ADMINS,
    })
    expect(did).toBeNull()
  })

  it('resolves a session for a runtime-granted admin not on the allowlist', async () => {
    const grantedDid = 'did:plc:spike-spiegel'
    const key = await store.create(grantedDid, 60_000)
    const req: any = { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${key}` } }
    const did = await resolveAdminSession(req, {
      adminSessionStore: store,
      adminDids: [ADMIN_DID],
      adminUserStore: grantedAdminStore(grantedDid),
    })
    expect(did).toBe(grantedDid)
  })

  it('returns null for a session DID that is neither allowlisted nor granted', async () => {
    const key = await store.create(INTRUDER_DID, 60_000)
    const req: any = { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${key}` } }
    const did = await resolveAdminSession(req, {
      adminSessionStore: store,
      adminDids: [ADMIN_DID],
      adminUserStore: grantedAdminStore('did:plc:spike-spiegel'),
    })
    expect(did).toBeNull()
  })
})

describe('isEffectiveAdmin (shared by the .admin verifier and /whoami)', () => {
  const GRANTED_DID = 'did:plc:faye-valentine'

  it('admits a DID on the config allowlist with no runtime grant', async () => {
    expect(
      await isEffectiveAdmin(ADMIN_DID, {
        adminDids: [ADMIN_DID],
        adminUserStore: NO_GRANTED_ADMINS,
      }),
    ).toBe(true)
  })

  it('admits a DID granted at runtime but absent from the allowlist', async () => {
    expect(
      await isEffectiveAdmin(GRANTED_DID, {
        adminDids: [ADMIN_DID],
        adminUserStore: grantedAdminStore(GRANTED_DID),
      }),
    ).toBe(true)
  })

  it('admits a DID that is both allowlisted and granted', async () => {
    expect(
      await isEffectiveAdmin(ADMIN_DID, {
        adminDids: [ADMIN_DID],
        adminUserStore: grantedAdminStore(ADMIN_DID),
      }),
    ).toBe(true)
  })

  it('rejects a DID in neither set', async () => {
    expect(
      await isEffectiveAdmin(INTRUDER_DID, {
        adminDids: [ADMIN_DID],
        adminUserStore: grantedAdminStore(GRANTED_DID),
      }),
    ).toBe(false)
  })
})
