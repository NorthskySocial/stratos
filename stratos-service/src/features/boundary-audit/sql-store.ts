import { sql, type SQL } from 'drizzle-orm'
import type { EnrollmentStoreWriter } from '@northskysocial/stratos-core'
import type { BoundaryAuditHead, BoundaryAuditTransaction } from './audit.js'
import {
  BoundaryHistoryTruncatedError,
  type SignedBoundaryOperation,
} from './model.js'

export interface BoundaryAuditSql {
  all: <T>(statement: SQL) => Promise<T[]>
  execute: (statement: SQL) => Promise<void>
}

interface AuditRow {
  operation: string
  hash: string
  signature: string
}

export async function migrateBoundaryAudit(
  connection: BoundaryAuditSql,
): Promise<void> {
  await connection.execute(sql`
    CREATE TABLE IF NOT EXISTS boundary_audit_head (
      did TEXT PRIMARY KEY,
      sequence BIGINT NOT NULL DEFAULT 0,
      hash TEXT NOT NULL DEFAULT ''
    )
  `)
  await connection.execute(sql`
    CREATE TABLE IF NOT EXISTS boundary_audit_operation (
      did TEXT NOT NULL,
      sequence BIGINT NOT NULL,
      operation TEXT NOT NULL,
      hash TEXT NOT NULL,
      signature TEXT NOT NULL,
      PRIMARY KEY (did, sequence)
    )
  `)
}

function decodeRow(row: AuditRow): SignedBoundaryOperation {
  try {
    const operation = JSON.parse(row.operation)
    if (operation === null) {
      throw new BoundaryHistoryTruncatedError()
    }
    return {
      operation,
      hash: row.hash,
      signature: row.signature,
    }
  } catch {
    throw new BoundaryHistoryTruncatedError()
  }
}

export function boundaryAuditTransaction(
  connection: BoundaryAuditSql,
  enrollmentStore: EnrollmentStoreWriter,
  did: string,
  head: BoundaryAuditHead,
): BoundaryAuditTransaction {
  return {
    enrollmentStore,
    head,
    async append(signed) {
      try {
        await connection.execute(sql`
          INSERT INTO boundary_audit_operation (did, sequence, operation, hash, signature)
          VALUES (${did}, ${signed.operation.sequence}, ${JSON.stringify(signed.operation)}, ${signed.hash}, ${signed.signature})
        `)
      } catch {
        // Drizzle errors contain query parameters, including private membership.
        throw new Error('Could not persist boundary audit operation')
      }
      const updated = await connection.all(sql`
        UPDATE boundary_audit_head SET sequence = ${signed.operation.sequence}, hash = ${signed.hash}
        WHERE did = ${did} AND sequence = ${head.sequence} AND hash = ${head.hash}
        RETURNING did
      `)
      if (updated.length !== 1)
        throw new Error('Boundary audit head changed during mutation')
    },
    async list(after, limit) {
      const rows = await connection.all<AuditRow>(sql`
        SELECT operation, hash, signature FROM boundary_audit_operation
        WHERE did = ${did} AND sequence > ${after}
        ORDER BY sequence LIMIT ${limit}
      `)
      return rows.map(decodeRow)
    },
  }
}
