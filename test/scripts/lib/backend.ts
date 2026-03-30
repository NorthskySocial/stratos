// Backend abstraction for E2E database operations.
// Delegates to SQLite (db.ts) or PostgreSQL (pg-db.ts) based on the
// STRATOS_E2E_BACKEND environment variable.

import * as sqliteDb from './db.ts'

export type Backend = 'sqlite' | 'postgres'

export function getBackend(): Backend {
  const backend = Deno.env.get('STRATOS_E2E_BACKEND')
  if (backend === 'postgres') return 'postgres'
  return 'sqlite'
}

export function isPostgres(): boolean {
  return getBackend() === 'postgres'
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
  if (isPostgres()) {
    const pg = await loadPgDb()
    await pg.enrollUser(did, pdsEndpoint, boundaries)
  } else {
    sqliteDb.enrollUser(did, pdsEndpoint, boundaries)
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
  if (isPostgres()) {
    const pg = await loadPgDb()
    await pg.setBoundaries(did, boundaries)
  } else {
    sqliteDb.setBoundaries(did, boundaries)
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
