import { sql } from 'drizzle-orm'
import type { ServiceDb } from '../../db/index.js'
import { SqliteEnrollmentStore } from '../../storage/sqlite/enrollment-store.js'
import type { BoundaryAuditBackend, BoundaryAuditTransaction } from './audit.js'
import { boundaryAuditTransaction, type BoundaryAuditSql } from './sql-store.js'

export function sqliteAuditSql(
  db: Pick<ServiceDb, 'all' | 'run'>,
): BoundaryAuditSql {
  return {
    all: (statement) => db.all(statement),
    execute: async (statement) => {
      await db.run(statement)
    },
  }
}

export class SqliteBoundaryAuditBackend implements BoundaryAuditBackend {
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly db: ServiceDb) {}

  transaction<T>(
    did: string,
    work: (tx: BoundaryAuditTransaction) => Promise<T>,
  ): Promise<T> {
    // libsql shares one connection. Do not overlap its transactions locally.
    const result = this.pending.then(() =>
      this.db.transaction(async (tx) => {
        const db = tx
        const connection = sqliteAuditSql(db)
        await db.run(sql`
        INSERT INTO boundary_audit_head (did) VALUES (${did}) ON CONFLICT DO NOTHING
      `)
        const [head] = await db.all<{ sequence: number; hash: string }>(sql`
        SELECT sequence, hash FROM boundary_audit_head WHERE did = ${did}
      `)
        return work(
          boundaryAuditTransaction(
            connection,
            new SqliteEnrollmentStore(db),
            did,
            head,
          ),
        )
      }),
    )
    this.pending = result.catch(() => undefined)
    return result
  }
}
