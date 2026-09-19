import { sql, type SQL } from 'drizzle-orm'
import type { ServiceDb } from '../../db/index.js'
import type { ServicePgDb } from '../../db/pg.js'

async function createTables(
  run: (statement: SQL) => Promise<unknown>,
): Promise<void> {
  await run(
    sql`CREATE TABLE IF NOT EXISTS boundary_catalog_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))`,
  )
  await run(sql`CREATE TABLE IF NOT EXISTS boundary_deactivation_member (
    boundary TEXT NOT NULL, did TEXT NOT NULL, PRIMARY KEY (boundary, did)
  )`)
  await run(sql`CREATE TABLE IF NOT EXISTS boundary_definition (
    boundary TEXT PRIMARY KEY, room_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    description TEXT NOT NULL, listed INTEGER NOT NULL, joinable INTEGER NOT NULL,
    auto_enroll INTEGER NOT NULL, app_access TEXT NOT NULL, client_ids TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'deactivating', 'inactive')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL
  )`)
}

export async function migrateSqliteBoundaries(db: ServiceDb): Promise<void> {
  await createTables((statement) => db.run(statement))
  // Enforce the grant fence in the database, including other service processes.
  await db.run(sql`CREATE TRIGGER IF NOT EXISTS boundary_membership_insert_guard
    BEFORE INSERT ON enrollment_boundary
    WHEN EXISTS (SELECT 1 FROM boundary_definition WHERE boundary = NEW.boundary AND status != 'active')
    BEGIN SELECT RAISE(ABORT, 'BoundaryUnavailable'); END`)
  await db.run(sql`CREATE TRIGGER IF NOT EXISTS boundary_membership_update_guard
    BEFORE UPDATE OF boundary ON enrollment_boundary
    WHEN EXISTS (SELECT 1 FROM boundary_definition WHERE boundary = NEW.boundary AND status != 'active')
    BEGIN SELECT RAISE(ABORT, 'BoundaryUnavailable'); END`)
}

export async function migratePgBoundaries(db: ServicePgDb): Promise<void> {
  await db.transaction(async (tx) => {
    await createTables((statement) => tx.execute(statement))
    await tx.execute(sql`CREATE OR REPLACE FUNCTION stratos_guard_boundary_membership() RETURNS trigger AS $$
    BEGIN
      PERFORM boundary FROM boundary_definition WHERE boundary = NEW.boundary AND status = 'active' FOR SHARE;
      IF NOT FOUND AND EXISTS (SELECT 1 FROM boundary_definition WHERE boundary = NEW.boundary) THEN
        RAISE EXCEPTION 'BoundaryUnavailable';
      END IF;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql`)
    await tx.execute(
      sql`DROP TRIGGER IF EXISTS boundary_membership_guard ON enrollment_boundary`,
    )
    await tx.execute(sql`CREATE TRIGGER boundary_membership_guard BEFORE INSERT OR UPDATE OF boundary ON enrollment_boundary
    FOR EACH ROW EXECUTE FUNCTION stratos_guard_boundary_membership()`)
  })
}
