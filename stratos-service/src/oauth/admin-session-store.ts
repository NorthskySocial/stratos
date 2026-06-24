import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
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
  constructor(private db: ServiceDb) {}

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
      await this.del(key)
      return undefined
    }
    return record
  }

  async del(key: string): Promise<void> {
    await this.db.delete(adminSession).where(eq(adminSession.key, key))
  }
}

/**
 * PostgreSQL-backed admin session store.
 */
export class PgAdminSessionStore implements AdminSessionStore {
  constructor(private db: ServicePgDb) {}

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
      await this.del(key)
      return undefined
    }
    return record
  }

  async del(key: string): Promise<void> {
    await this.db.delete(pgAdminSession).where(eq(pgAdminSession.key, key))
  }
}
