import { eq } from 'drizzle-orm'
import type { Logger } from '@northskysocial/stratos-core'
import { adminUser, type ServiceDb } from '../db'
import { pgAdminUser } from '../db/pg-schema.js'
import type { ServicePgDb } from '../db/pg.js'

/**
 * An admin granted through the management API rather than configuration.
 */
export interface AdminUserRecord {
  did: string
  addedAt: string
  /** The admin who granted this one, absent for rows predating the field. */
  addedBy?: string
}

/**
 * Persistence for admins granted at runtime.
 *
 * Config-provided admins (`STRATOS_ADMIN_DIDS`) are deliberately NOT stored
 * here: they are the recovery floor, so they cannot be revoked through the
 * API. The effective admin set is the union of the two.
 */
export interface AdminUserStore {
  list: () => Promise<AdminUserRecord[]>
  has: (did: string) => Promise<boolean>
  add: (did: string, addedBy: string) => Promise<void>
  remove: (did: string) => Promise<void>
}

/**
 * The effective admin set is the union of the config allowlist (recovery
 * floor, un-revocable) and the runtime grants in the store. Both the
 * request-time `.admin` verifier and the `/whoami` session resolver MUST
 * decide membership through this predicate so the two can never drift.
 */
export async function isEffectiveAdmin(
  did: string,
  deps: { adminDids: string[]; adminUserStore: Pick<AdminUserStore, 'has'> },
): Promise<boolean> {
  return deps.adminDids.includes(did) || (await deps.adminUserStore.has(did))
}

/**
 * SQLite-backed admin user store.
 */
export class SqliteAdminUserStore implements AdminUserStore {
  constructor(
    private db: ServiceDb,
    private logger?: Logger,
  ) {}

  async list(): Promise<AdminUserRecord[]> {
    const rows = await this.db.select().from(adminUser).orderBy(adminUser.did)
    return rows.map((row) => ({
      did: row.did,
      addedAt: row.addedAt,
      addedBy: row.addedBy ?? undefined,
    }))
  }

  async has(did: string): Promise<boolean> {
    const rows = await this.db
      .select({ did: adminUser.did })
      .from(adminUser)
      .where(eq(adminUser.did, did))
      .limit(1)
    return rows.length > 0
  }

  async add(did: string, addedBy: string): Promise<void> {
    await this.db
      .insert(adminUser)
      .values({ did, addedAt: new Date().toISOString(), addedBy })
      .onConflictDoNothing()
    this.logger?.info({ did, addedBy }, 'admin granted')
  }

  async remove(did: string): Promise<void> {
    await this.db.delete(adminUser).where(eq(adminUser.did, did))
    this.logger?.info({ did }, 'admin revoked')
  }
}

/**
 * Postgres-backed admin user store.
 */
export class PgAdminUserStore implements AdminUserStore {
  constructor(
    private db: ServicePgDb,
    private logger?: Logger,
  ) {}

  async list(): Promise<AdminUserRecord[]> {
    const rows = await this.db
      .select()
      .from(pgAdminUser)
      .orderBy(pgAdminUser.did)
    return rows.map((row) => ({
      did: row.did,
      addedAt: row.addedAt,
      addedBy: row.addedBy ?? undefined,
    }))
  }

  async has(did: string): Promise<boolean> {
    const rows = await this.db
      .select({ did: pgAdminUser.did })
      .from(pgAdminUser)
      .where(eq(pgAdminUser.did, did))
      .limit(1)
    return rows.length > 0
  }

  async add(did: string, addedBy: string): Promise<void> {
    await this.db
      .insert(pgAdminUser)
      .values({ did, addedAt: new Date().toISOString(), addedBy })
      .onConflictDoNothing()
    this.logger?.info({ did, addedBy }, 'admin granted')
  }

  async remove(did: string): Promise<void> {
    await this.db.delete(pgAdminUser).where(eq(pgAdminUser.did, did))
    this.logger?.info({ did }, 'admin revoked')
  }
}
