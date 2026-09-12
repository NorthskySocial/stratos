import { sql, type SQL } from 'drizzle-orm'
import type {
  BoundaryCatalogStore,
  BoundaryDefinition,
  BoundarySettings,
} from '@northskysocial/stratos-core'
import type { ServiceDb } from '../../db/index.js'
import type { ServicePgDb } from '../../db/pg.js'

interface BoundarySql {
  read: (statement: SQL) => Promise<Record<string, unknown>[]>
  write: (statement: SQL) => Promise<void>
}

type Transaction = <T>(
  work: (connection: BoundarySql) => Promise<T>,
) => Promise<T>

export function createSqliteBoundaryStore(db: ServiceDb): BoundaryCatalogStore {
  const connection: BoundarySql = {
    read: (statement) => db.all(statement),
    write: async (statement) => {
      await db.run(statement)
    },
  }
  return new SqlBoundaryCatalogStore(connection, (work) =>
    db.transaction((tx) =>
      work({
        read: (statement) => tx.all(statement),
        write: async (statement) => {
          await tx.run(statement)
        },
      }),
    ),
  )
}

export function createPgBoundaryStore(db: ServicePgDb): BoundaryCatalogStore {
  const connection: BoundarySql = {
    read: async (statement) => [...(await db.execute(statement))],
    write: async (statement) => {
      await db.execute(statement)
    },
  }
  return new SqlBoundaryCatalogStore(connection, (work) =>
    db.transaction((tx) =>
      work({
        read: async (statement) => [...(await tx.execute(statement))],
        write: async (statement) => {
          await tx.execute(statement)
        },
      }),
    ),
  )
}

class SqlBoundaryCatalogStore implements BoundaryCatalogStore {
  constructor(
    private readonly db: BoundarySql,
    private readonly transaction: Transaction,
  ) {}

  async initialize(definitions: BoundaryDefinition[]): Promise<void> {
    await this.transaction(async (db) => {
      // The marker is claimed in the same transaction as the one-time import.
      const claimed =
        await db.read(sql`INSERT INTO boundary_catalog_state (singleton) VALUES (1)
        ON CONFLICT DO NOTHING RETURNING singleton`)
      if (claimed.length === 0) return
      for (const definition of definitions)
        await insertDefinition(db, definition)
    })
  }

  async list(): Promise<BoundaryDefinition[]> {
    return (
      await this.db.read(
        sql`SELECT * FROM boundary_definition ORDER BY boundary`,
      )
    ).map(decodeDefinition)
  }

  async get(boundary: string): Promise<BoundaryDefinition | null> {
    const [row] = await this.db.read(
      sql`SELECT * FROM boundary_definition WHERE boundary = ${boundary}`,
    )
    return row ? decodeDefinition(row) : null
  }

  create(definition: BoundaryDefinition): Promise<void> {
    return insertDefinition(this.db, definition)
  }

  async update(
    boundary: string,
    settings: BoundarySettings,
    revision: number,
  ): Promise<boolean> {
    const rows = await this.db.read(sql`UPDATE boundary_definition SET
      display_name = ${settings.displayName}, description = ${settings.description},
      listed = ${Number(settings.listed)}, joinable = ${Number(settings.joinable)},
      auto_enroll = ${Number(settings.autoEnroll)}, app_access = ${settings.appAccess},
      client_ids = ${JSON.stringify(settings.clientIds)}, updated_at = ${new Date().toISOString()},
      revision = revision + 1 WHERE boundary = ${boundary} AND revision = ${revision}
      AND status != 'deactivating' RETURNING boundary`)
    return rows.length > 0
  }

  async beginDeactivation(
    boundary: string,
    revision: number,
  ): Promise<boolean> {
    return this.transaction(async (db) => {
      const rows =
        await db.read(sql`UPDATE boundary_definition SET status = 'deactivating',
        updated_at = ${new Date().toISOString()}, revision = revision + 1
        WHERE boundary = ${boundary} AND revision = ${revision} AND status = 'active' RETURNING boundary`)
      if (rows.length === 0) return false
      await db.write(sql`INSERT INTO boundary_deactivation_member (boundary, did)
        SELECT boundary, did FROM enrollment_boundary WHERE boundary = ${boundary} ON CONFLICT DO NOTHING`)
      return true
    })
  }

  async finishDeactivation(boundary: string): Promise<boolean> {
    const rows = await this.db
      .read(sql`UPDATE boundary_definition SET status = 'inactive',
      updated_at = ${new Date().toISOString()}, revision = revision + 1
      WHERE boundary = ${boundary} AND status = 'deactivating'
      AND NOT EXISTS (SELECT 1 FROM enrollment_boundary WHERE boundary = ${boundary})
      AND NOT EXISTS (SELECT 1 FROM boundary_deactivation_member WHERE boundary = ${boundary}) RETURNING boundary`)
    return rows.length > 0
  }

  async reactivate(boundary: string, revision: number): Promise<boolean> {
    const rows = await this.db
      .read(sql`UPDATE boundary_definition SET status = 'active',
      updated_at = ${new Date().toISOString()}, revision = revision + 1
      WHERE boundary = ${boundary} AND revision = ${revision} AND status = 'inactive'
      AND NOT EXISTS (SELECT 1 FROM enrollment_boundary WHERE boundary = ${boundary})
      AND NOT EXISTS (SELECT 1 FROM boundary_deactivation_member WHERE boundary = ${boundary}) RETURNING boundary`)
    return rows.length > 0
  }

  async listDeactivationMembers(
    boundary: string,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.db.read(
      sql`SELECT did FROM boundary_deactivation_member WHERE boundary = ${boundary} ORDER BY did LIMIT ${limit}`,
    )
    return rows.map((row) => String(row.did))
  }

  async completeDeactivationMember(
    boundary: string,
    did: string,
  ): Promise<void> {
    await this.db.write(
      sql`DELETE FROM boundary_deactivation_member WHERE boundary = ${boundary} AND did = ${did}`,
    )
  }

  async countMembers(boundary: string): Promise<number> {
    const [row] = await this.db.read(
      sql`SELECT count(*) AS count FROM enrollment_boundary WHERE boundary = ${boundary}`,
    )
    return Number(row.count)
  }
}

async function insertDefinition(
  db: BoundarySql,
  definition: BoundaryDefinition,
): Promise<void> {
  const d = definition
  await db.write(sql`INSERT INTO boundary_definition
    (boundary, room_id, display_name, description, listed, joinable, auto_enroll, app_access, client_ids, status, created_at, updated_at, revision)
    VALUES (${d.boundary}, ${d.roomId}, ${d.displayName}, ${d.description}, ${Number(d.listed)}, ${Number(d.joinable)},
      ${Number(d.autoEnroll)}, ${d.appAccess}, ${JSON.stringify(d.clientIds)}, ${d.status}, ${d.createdAt}, ${d.updatedAt}, ${d.revision})`)
}

function decodeDefinition(row: Record<string, unknown>): BoundaryDefinition {
  return {
    boundary: String(row.boundary),
    roomId: String(row.room_id),
    displayName: String(row.display_name),
    description: String(row.description),
    listed: Number(row.listed) === 1,
    joinable: Number(row.joinable) === 1,
    autoEnroll: Number(row.auto_enroll) === 1,
    appAccess: row.app_access as BoundaryDefinition['appAccess'],
    clientIds: JSON.parse(String(row.client_ids)) as string[],
    status: row.status as BoundaryDefinition['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    revision: Number(row.revision),
  }
}
