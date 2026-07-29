// Backend abstraction for E2E database operations.
// Delegates to SQLite (db.ts) or PostgreSQL (pg-db.ts) based on the
// STRATOS_E2E_BACKEND environment variable.
//
// Boundary writes mirror the service's reserved-domain invariant: the service
// force-includes the reserved all-members domain on every enrollment write
// (ReservedDomainEnrollmentStore), so direct DB writes must do the same or
// direct-mode state diverges from what OAuth enrollment produces.

import * as sqliteDb from './db.ts'
import { RESERVED_DOMAIN } from './config.ts'

/** Union the reserved all-members domain into a requested boundary set. */
function withReserved(boundaries: string[] = []): string[] {
  return boundaries.includes(RESERVED_DOMAIN)
    ? boundaries
    : [...boundaries, RESERVED_DOMAIN]
}

export type Backend = 'sqlite' | 'postgres'

export function getBackend(): Backend {
  const backend = Deno.env.get('STRATOS_E2E_BACKEND')
  if (backend === 'postgres') return 'postgres'
  return 'sqlite'
}

export function isPostgres(): boolean {
  return getBackend() === 'postgres'
}

/**
 * AppView E2E mode: brings up the Stratos + AppView stack (docker-compose.e2e.yml)
 * so the service-auth subscription path can be exercised end-to-end. Implies the
 * postgres backend, since the AppView indexes from the shared Postgres instance.
 */
export function isAppview(): boolean {
  return Deno.env.get('STRATOS_E2E_APPVIEW') === 'true'
}

interface DbOperations {
  enrollUser(
    did: string,
    pdsEndpoint?: string,
    boundaries?: string[],
  ): void | Promise<void>
  createActorStore(did: string): void | Promise<void>
  setBoundaries(did: string, boundaries: string[]): void | Promise<void>
  getBoundaries(did: string): string[] | Promise<string[]>
  isEnrolled(did: string): boolean | Promise<boolean>
}

async function loadPgDb(): Promise<DbOperations> {
  return await import('./pg-db.ts')
}

export async function enrollUser(
  did: string,
  pdsEndpoint?: string,
  boundaries?: string[],
): Promise<void> {
  const effective = withReserved(boundaries)
  if (isPostgres()) {
    const pg = await loadPgDb()
    await pg.enrollUser(did, pdsEndpoint, effective)
  } else {
    sqliteDb.enrollUser(did, pdsEndpoint, effective)
  }
}

export async function createActorStore(did: string): Promise<void> {
  if (isPostgres()) {
    const pg = await loadPgDb()
    await pg.createActorStore(did)
  } else {
    await sqliteDb.createActorStore(did)
  }
}

export async function setBoundaries(
  did: string,
  boundaries: string[],
): Promise<void> {
  const effective = withReserved(boundaries)
  if (isPostgres()) {
    const pg = await loadPgDb()
    await pg.setBoundaries(did, effective)
  } else {
    sqliteDb.setBoundaries(did, effective)
  }
}

export async function getBoundaries(did: string): Promise<string[]> {
  if (isPostgres()) {
    const pg = await loadPgDb()
    return pg.getBoundaries(did)
  } else {
    return sqliteDb.getBoundaries(did)
  }
}

export async function isEnrolled(did: string): Promise<boolean> {
  if (isPostgres()) {
    const pg = await loadPgDb()
    return pg.isEnrolled(did)
  } else {
    return sqliteDb.isEnrolled(did)
  }
}
