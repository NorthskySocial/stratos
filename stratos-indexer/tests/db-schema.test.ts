import { describe, expect, it, vi } from 'vitest'
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from 'kysely'
import type { Database } from '@atproto/bsky'
import { ensureIndexerSchema } from '../src/storage/db.js'

const TARGET_ENROLLMENT_COLUMNS = [
  'did',
  'serviceUrl',
  'enrolledAt',
  'lastChecked',
  'boundaries',
]

/**
 * In-memory schema simulator: tracks each table's column set and enforces the
 * same DDL rules Postgres does, so tests observe the schema end-state rather
 * than the exact statement sequence.
 */
class FakePostgres {
  readonly tables = new Map<string, Set<string>>()
  readonly statements: string[] = []
  failOn?: (sql: string) => boolean

  constructor(seed: Record<string, string[]> = {}) {
    for (const [table, columns] of Object.entries(seed)) {
      this.tables.set(table, new Set(columns))
    }
  }

  columns(table: string): string[] {
    return [...(this.tables.get(table) ?? [])].sort()
  }

  execute(query: CompiledQuery): QueryResult<Record<string, unknown>> {
    const text = query.sql
    this.statements.push(text)
    if (this.failOn?.(text)) {
      throw new Error(`injected failure for: ${text}`)
    }

    if (text.includes('information_schema.columns')) {
      const [table, ...names] = query.parameters as string[]
      const existing = this.tables.get(table)
      const rows = names
        .filter((name) => existing?.has(name))
        .map((name) => ({ column_name: name }))
      return { rows }
    }

    const createTable = text.match(
      /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*)\)/,
    )
    if (createTable) {
      const [, table, body] = createTable
      if (!this.tables.has(table)) {
        this.tables.set(table, new Set(parseColumnNames(body)))
      }
      return { rows: [] }
    }

    const rename = text.match(
      /ALTER TABLE\s+"?(\w+)"?\s+RENAME COLUMN\s+"?(\w+)"?\s+TO\s+"?(\w+)"?/,
    )
    if (rename) {
      const [, table, from, to] = rename
      const existing = this.tables.get(table)
      if (!existing) throw new Error(`relation "${table}" does not exist`)
      if (!existing.has(from)) {
        throw new Error(`column "${from}" does not exist`)
      }
      if (existing.has(to)) {
        throw new Error(`column "${to}" already exists`)
      }
      existing.delete(from)
      existing.add(to)
      return { rows: [] }
    }

    const addColumn = text.match(
      /ALTER TABLE\s+"?(\w+)"?\s+ADD COLUMN IF NOT EXISTS\s+"?(\w+)"?/,
    )
    if (addColumn) {
      const [, table, column] = addColumn
      const existing = this.tables.get(table)
      if (!existing) throw new Error(`relation "${table}" does not exist`)
      existing.add(column)
      return { rows: [] }
    }

    if (text.includes('CREATE INDEX')) {
      return { rows: [] }
    }

    throw new Error(`unexpected statement: ${text}`)
  }
}

function parseColumnNames(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('PRIMARY KEY'))
    .map((line) => line.match(/^"?([A-Za-z_]+)"?/)?.[1])
    .filter((name): name is string => name !== undefined)
}

function createFakeDb(seed: Record<string, string[]> = {}): {
  db: Database
  fake: FakePostgres
} {
  const fake = new FakePostgres(seed)
  const connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery) =>
      fake.execute(query) as QueryResult<R>,
    streamQuery: () => {
      throw new Error('streaming is not supported')
    },
  }
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  }
  const dialect: Dialect = {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => driver,
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  }
  const db = { db: new Kysely({ dialect }) } as unknown as Database
  return { db, fake }
}

describe('ensureIndexerSchema enrollment repair', () => {
  it('repairs the unquoted legacy bootstrap layout', async () => {
    const { db, fake } = createFakeDb({
      stratos_enrollment: ['did', 'serviceurl', 'createdat', 'updatedat'],
    })

    await ensureIndexerSchema(db)

    expect(fake.columns('stratos_enrollment')).toEqual(
      [...TARGET_ENROLLMENT_COLUMNS].sort(),
    )
  })

  it('repairs the quoted createdAt/updatedAt intermediate layout', async () => {
    const { db, fake } = createFakeDb({
      stratos_enrollment: ['did', 'serviceUrl', 'createdAt', 'updatedAt'],
    })

    await ensureIndexerSchema(db)

    expect(fake.columns('stratos_enrollment')).toEqual(
      [...TARGET_ENROLLMENT_COLUMNS].sort(),
    )
  })

  it('repairs the lowercase enrolledat/lastchecked layout', async () => {
    const { db, fake } = createFakeDb({
      stratos_enrollment: ['did', 'serviceurl', 'enrolledat', 'lastchecked'],
    })

    await ensureIndexerSchema(db)

    expect(fake.columns('stratos_enrollment')).toEqual(
      [...TARGET_ENROLLMENT_COLUMNS].sort(),
    )
  })

  it('is idempotent across a second run on a repaired legacy layout', async () => {
    const { db, fake } = createFakeDb({
      stratos_enrollment: ['did', 'serviceurl', 'createdat', 'updatedat'],
    })

    await ensureIndexerSchema(db)
    // the fake throws on a duplicate rename, so a second run
    // proves that each repair statement is idempotent
    await ensureIndexerSchema(db)

    expect(fake.columns('stratos_enrollment')).toEqual(
      [...TARGET_ENROLLMENT_COLUMNS].sort(),
    )
  })

  it('leaves the current layout untouched apart from the idempotent boundaries add', async () => {
    const { db, fake } = createFakeDb({
      stratos_enrollment: [...TARGET_ENROLLMENT_COLUMNS],
    })

    await ensureIndexerSchema(db)

    expect(fake.columns('stratos_enrollment')).toEqual(
      [...TARGET_ENROLLMENT_COLUMNS].sort(),
    )
    const enrollmentRenames = fake.statements.filter(
      (sql) =>
        sql.includes('RENAME COLUMN') && sql.includes('stratos_enrollment'),
    )
    expect(enrollmentRenames).toEqual([])
    const boundariesAdd = fake.statements.find((sql) =>
      sql.includes('ADD COLUMN IF NOT EXISTS boundaries'),
    )
    expect(boundariesAdd).toBeDefined()
  })

  it('bootstraps a fresh database with the target layout and repairs after creation', async () => {
    const { db, fake } = createFakeDb()

    await ensureIndexerSchema(db)

    expect(fake.columns('stratos_enrollment')).toEqual(
      [...TARGET_ENROLLMENT_COLUMNS].sort(),
    )
    expect(fake.tables.has('stratos_sync_cursor')).toBe(true)
    expect(fake.tables.has('stratos_record')).toBe(true)
    expect(fake.tables.has('stratos_record_boundary')).toBe(true)
    expect(fake.tables.has('post')).toBe(true)

    const createIdx = fake.statements.findIndex((sql) =>
      sql.includes('CREATE TABLE IF NOT EXISTS stratos_enrollment'),
    )
    const repairIdx = fake.statements.findIndex((sql) =>
      sql.includes('ADD COLUMN IF NOT EXISTS boundaries'),
    )
    expect(createIdx).toBeGreaterThanOrEqual(0)
    expect(repairIdx).toBeGreaterThan(createIdx)
  })

  it('does not rename when the old and new column names coexist', async () => {
    const { db, fake } = createFakeDb({
      stratos_enrollment: [
        'did',
        'serviceUrl',
        'createdat',
        'enrolledAt',
        'lastChecked',
      ],
    })

    await ensureIndexerSchema(db)

    // the repair keeps the relic column and touches nothing else —
    // assert the exact residual set the repair guarantees
    expect(fake.columns('stratos_enrollment')).toEqual(
      [
        'boundaries',
        'createdat',
        'did',
        'enrolledAt',
        'lastChecked',
        'serviceUrl',
      ].sort(),
    )
  })

  it('fails startup when the boundaries repair fails', async () => {
    const { db, fake } = createFakeDb({
      stratos_enrollment: [...TARGET_ENROLLMENT_COLUMNS],
    })
    fake.failOn = (sql) => sql.includes('ADD COLUMN IF NOT EXISTS boundaries')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(ensureIndexerSchema(db)).rejects.toThrow('injected failure')

    consoleError.mockRestore()
  })
})
