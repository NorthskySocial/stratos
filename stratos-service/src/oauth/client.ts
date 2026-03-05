import {
  NodeOAuthClient,
  NodeSavedSession,
  ResolvedHandle,
  ResolveHandleOptions,
} from '@atproto/oauth-client-node'
import { JoseKey } from '@atproto/jwk-jose'
import { IdResolver } from '@atproto/identity'
import { eq } from 'drizzle-orm'
import { oauthSession, oauthState, type ServiceDb } from '../db/index.js'

/**
 * Granular OAuth scopes for PDS access.
 * Covers writing enrollment records and stub records for all Stratos record types.
 */
export const OAUTH_SCOPE = [
  'atproto',
  'repo:zone.stratos.actor.enrollment',
  'repo:zone.stratos.feed.post',
].join(' ')

/**
 * Database schema for OAuth session storage
 */
export interface OAuthSessionTable {
  key: string
  session: string
  createdAt: string
  updatedAt: string
}

export interface OAuthStateTable {
  key: string
  state: string
  createdAt: string
}

export interface OAuthSessionDb {
  oauth_session: OAuthSessionTable
  oauth_state: OAuthStateTable
}

/**
 * SQLite session store for OAuth client
 */
export class SqliteSessionStore {
  constructor(private db: ServiceDb) {}

  async get(key: string): Promise<NodeSavedSession | undefined> {
    const rows = await this.db
      .select()
      .from(oauthSession)
      .where(eq(oauthSession.key, key))
      .limit(1)

    const row = rows[0]
    if (!row) return undefined
    return JSON.parse(row.session) as NodeSavedSession
  }

  async set(key: string, session: NodeSavedSession): Promise<void> {
    const now = new Date().toISOString()
    const sessionStr = JSON.stringify(session)

    await this.db
      .insert(oauthSession)
      .values({
        key,
        session: sessionStr,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: oauthSession.key,
        set: {
          session: sessionStr,
          updatedAt: now,
        },
      })
  }

  async del(key: string): Promise<void> {
    await this.db.delete(oauthSession).where(eq(oauthSession.key, key))
  }
}

/**
 * SQLite state store for OAuth authorization flow
 */
export class SqliteStateStore {
  constructor(private db: ServiceDb) {}

  async get(key: string): Promise<string | undefined> {
    const rows = await this.db
      .select()
      .from(oauthState)
      .where(eq(oauthState.key, key))
      .limit(1)

    return rows[0]?.state
  }

  async set(key: string, state: string): Promise<void> {
    const now = new Date().toISOString()

    await this.db
      .insert(oauthState)
      .values({
        key,
        state,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: oauthState.key,
        set: { state },
      })
  }

  async del(key: string): Promise<void> {
    await this.db.delete(oauthState).where(eq(oauthState.key, key))
  }
}

/**
 * Configuration for OAuth client
 */
export interface OAuthClientConfig {
  clientId: string
  clientUri: string
  redirectUri: string
  privateKeyPem?: string
  scope?: string
  clientName?: string
  logoUri?: string
  tosUri?: string
  policyUri?: string
}

/**
 * Create an OAuth client for Stratos service
 */
export async function createOAuthClient(
  config: OAuthClientConfig,
  db: ServiceDb,
  idResolver: IdResolver,
): Promise<NodeOAuthClient> {
  const sessionStore = new SqliteSessionStore(db)
  const stateStore = new SqliteStateStore(db)

  // Create the client key if provided
  let clientKey: JoseKey | undefined = undefined
  if (config.privateKeyPem) {
    clientKey = await JoseKey.fromImportable(config.privateKeyPem, 'key-1')
  }

  return new NodeOAuthClient({
    clientMetadata: {
      client_id: config.clientId,
      client_name: config.clientName ?? 'Stratos Service',
      client_uri: config.clientUri,
      ...(config.logoUri && { logo_uri: config.logoUri }),
      ...(config.tosUri && { tos_uri: config.tosUri }),
      ...(config.policyUri && { policy_uri: config.policyUri }),
      redirect_uris: [config.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: config.scope ?? OAUTH_SCOPE,
      token_endpoint_auth_method: clientKey ? 'private_key_jwt' : 'none',
      dpop_bound_access_tokens: true,
      application_type: 'web',
    },

    keyset: clientKey ? [clientKey] : undefined,

    stateStore: {
      async get(key: string) {
        const state = await stateStore.get(key)
        return state ? JSON.parse(state) : undefined
      },
      async set(key: string, value: unknown) {
        await stateStore.set(key, JSON.stringify(value))
      },
      async del(key: string) {
        await stateStore.del(key)
      },
    },

    sessionStore: {
      async get(sub: string) {
        return sessionStore.get(sub)
      },
      async set(sub: string, session: NodeSavedSession) {
        await sessionStore.set(sub, session)
      },
      async del(sub: string) {
        await sessionStore.del(sub)
      },
    },

    // Use our identity resolver for handle resolution
    handleResolver: {
      resolve: async (
        handle: string,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        options: ResolveHandleOptions | undefined,
      ) => {
        // HandleResolver expects a ResolvedHandle; fall back to empty string if unresolved
        const did = await idResolver.handle.resolve(handle)
        return (did ?? null) as unknown as ResolvedHandle
      },
    },
  })
}

// Migrations are now handled in ../db/index.ts via migrateServiceDb()
// Keeping this export for type compatibility
export const oauthMigrations = {}
