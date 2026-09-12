import { sql } from 'drizzle-orm'
import type { ServicePgDb } from '../../db/pg.js'
import { PgEnrollmentStoreWriter } from '../../infra/storage/postgres/enrollment-store.js'
import type { BoundaryAuditBackend, BoundaryAuditTransaction } from './audit.js'
import { boundaryAuditTransaction, type BoundaryAuditSql } from './sql-store.js'

export function pgAuditSql(db: Pick<ServicePgDb, 'execute'>): BoundaryAuditSql {
  return {
    all: async <T>(statement: Parameters<ServicePgDb['execute']>[0]) =>
      [...(await db.execute(statement))] as T[],
    execute: async (statement) => {
      await db.execute(statement)
    },
  }
}

export class PgBoundaryAuditBackend implements BoundaryAuditBackend {
  constructor(private readonly db: ServicePgDb) {}

  transaction<T>(
    did: string,
    work: (tx: BoundaryAuditTransaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const db = tx
      const connection = pgAuditSql(db)
      await db.execute(sql`
        INSERT INTO boundary_audit_head (did) VALUES (${did}) ON CONFLICT DO NOTHING
      `)
      const [row] = await connection.all<{
        sequence: string
        hash: string
      }>(sql`
        SELECT sequence, hash FROM boundary_audit_head WHERE did = ${did} FOR UPDATE
      `)
      const head = { sequence: Number(row.sequence), hash: row.hash }
      return work(
        boundaryAuditTransaction(
          connection,
          new PgEnrollmentStoreWriter(db),
          did,
          head,
        ),
      )
    })
  }
}
