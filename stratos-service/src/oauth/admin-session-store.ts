import { randomBytes } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import type { Logger } from '@northskysocial/stratos-core'
import { adminSession, type ServiceDb } from '../db'
import { pgAdminSession } from '../db/pg-schema.js'
import type { ServicePgDb } from '../db/pg.js'

/**
 * A server-side admin session. The opaque `key` is the only value placed in the
 * cookie; the DID and lifetime live exclusively in the database.
 */
export interface AdminSessionRecord {
  did: string
  createdAt: string
  expiresAt: string
}

/**
 * Persistence for admin web sessions. Sessions are keyed by a cryptographically
 * random, opaque id and carry only the authenticated admin DID plus expiry.
 */
export interface AdminSessionStore {
  create(did: string, ttlMs: number): Promise<string>
  get(key: string): Promise<AdminSessionRecord | undefined>
  del(key: string): Promise<void>
  /**
   * Delete every session whose expiry has passed. Returns the number of rows
   * removed. Intended for a periodic sweep so expired rows don't accumulate
   * between the lazy, on-read cleanups in {@link AdminSessionStore.get}.
   */
  deleteExpired(): Promise<number>
}

const SESSION_KEY_BYTES = 32

function newSessionKey(): string {
  return randomBytes(SESSION_KEY_BYTES).toString('base64url')
}

function sessionTimestamps(ttlMs: number): {
  createdAt: string
  expiresAt: string
} {
  const now = Date.now()
  return {
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  }
}

function isExpired(record: AdminSessionRecord): boolean {
  return Date.parse(record.expiresAt) <= Date.now()
}

/**
 * SQLite-backed admin session store.
 */
export class SqliteAdminSessionStore implements AdminSessionStore {
  constructor(
    private db: ServiceDb,
    private logger?: Logger,
  ) {}

  async create(did: string, ttlMs: number): Promise<string> {
    const key = newSessionKey()
    const { createdAt, expiresAt } = sessionTimestamps(ttlMs)
    await this.db
      .insert(adminSession)
      .values({ key, did, createdAt, expiresAt })
    return key
  }

  async get(key: string): Promise<AdminSessionRecord | undefined> {
    const rows = await this.db
      .select()
      .from(adminSession)
      .where(eq(adminSession.key, key))
      .limit(1)

    const row = rows[0]
    if (!row) return undefined
    const record: AdminSessionRecord = {
      did: row.did,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    }
    if (isExpired(record)) {
      try {
        await this.del(key)
      } catch (err) {
        // The session is gone as far as the caller is concerned (expiry was
        // checked in-memory above); a failed delete only means the stale row
        // lingers for the periodic sweep. Surface it so a recurring storage
        // fault isn't silently masked.
        this.logger?.warn(
          { err },
          'admin session: failed to purge expired session on read',
        )
      }
      return undefined
    }
    return record
  }

  async del(key: string): Promise<void> {
    await this.db.delete(adminSession).where(eq(adminSession.key, key))
  }

  async deleteExpired(): Promise<number> {
    const now = new Date().toISOString()
    const deleted = await this.db
      .delete(adminSession)
      .where(lt(adminSession.expiresAt, now))
      .returning({ key: adminSession.key })
    return deleted.length
  }
}

/**
 * PostgreSQL-backed admin session store.
 */
export class PgAdminSessionStore implements AdminSessionStore {
  constructor(
    private db: ServicePgDb,
    private logger?: Logger,
  ) {}

  async create(did: string, ttlMs: number): Promise<string> {
    const key = newSessionKey()
    const { createdAt, expiresAt } = sessionTimestamps(ttlMs)
    await this.db
      .insert(pgAdminSession)
      .values({ key, did, createdAt, expiresAt })
    return key
  }

  async get(key: string): Promise<AdminSessionRecord | undefined> {
    const rows = await this.db
      .select()
      .from(pgAdminSession)
      .where(eq(pgAdminSession.key, key))
      .limit(1)

    const row = rows[0]
    if (!row) return undefined
    const record: AdminSessionRecord = {
      did: row.did,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    }
    if (isExpired(record)) {
      try {
        await this.del(key)
      } catch (err) {
        this.logger?.warn(
          { err },
          'admin session: failed to purge expired session on read',
        )
      }
      return undefined
    }
    return record
  }

  async del(key: string): Promise<void> {
    await this.db.delete(pgAdminSession).where(eq(pgAdminSession.key, key))
  }

  async deleteExpired(): Promise<number> {
    const now = new Date().toISOString()
    const deleted = await this.db
      .delete(pgAdminSession)
      .where(lt(pgAdminSession.expiresAt, now))
      .returning({ key: pgAdminSession.key })
    return deleted.length
  }
}
