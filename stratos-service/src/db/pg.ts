import postgres from 'postgres'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import * as pgSchema from './pg-schema.js'

type ServicePgClient = ReturnType<typeof postgres>

export interface ServicePgStartupDiagnostics {
  currentDatabase: string
  currentUser: string
  currentSchema: string | null
  searchPath: string
  hasDatabaseCreate: boolean
  hasSchemaUsage: boolean | null
  hasSchemaCreate: boolean | null
}

export type ServicePgDb = PostgresJsDatabase<typeof pgSchema> & {
  $client: ServicePgClient
}

export function createServicePgDb(connectionString: string): ServicePgDb {
  const client = postgres(connectionString, { max: 10 })
  return drizzle({ client, schema: pgSchema }) as unknown as ServicePgDb
}

function formatStartupDiagnostics(
  diagnostics: ServicePgStartupDiagnostics,
): string {
  return [
    `database=${diagnostics.currentDatabase}`,
    `user=${diagnostics.currentUser}`,
    `schema=${diagnostics.currentSchema ?? '(none)'}`,
    `search_path=${diagnostics.searchPath}`,
    `hasDatabaseCreate=${diagnostics.hasDatabaseCreate}`,
    `hasSchemaUsage=${diagnostics.hasSchemaUsage ?? 'unknown'}`,
    `hasSchemaCreate=${diagnostics.hasSchemaCreate ?? 'unknown'}`,
  ].join(', ')
}

function extractPgErrorDetails(error: unknown): string {
  const details = new Set<string>()

  for (const candidate of [
    error,
    error instanceof Error ? error.cause : undefined,
  ]) {
    if (!candidate || typeof candidate !== 'object') continue

    for (const key of [
      'code',
      'severity',
      'detail',
      'hint',
      'schema',
      'table',
      'constraint',
    ]) {
      const value = Reflect.get(candidate, key)
      if (typeof value === 'string' && value.length > 0) {
        details.add(`${key}=${value}`)
      }
    }
  }

  return [...details].join(', ')
}

export async function checkServicePgDbStartup(
  db: ServicePgDb,
): Promise<ServicePgStartupDiagnostics> {
  const client = db.$client as ServicePgClient

  const [context] = await client<
    Array<{
      currentDatabase: string
      currentUser: string
      currentSchema: string | null
      searchPath: string
    }>
  >`
    SELECT
      current_database() AS "currentDatabase",
      current_user AS "currentUser",
      current_schema() AS "currentSchema",
      current_setting('search_path') AS "searchPath"
  `

  const [privileges] = await client<
    Array<{
      hasDatabaseCreate: boolean
      hasSchemaUsage: boolean | null
      hasSchemaCreate: boolean | null
    }>
  >`
    SELECT
      has_database_privilege(current_user, current_database(), 'CREATE') AS "hasDatabaseCreate",
      CASE
        WHEN current_schema() IS NULL THEN NULL
        ELSE has_schema_privilege(current_user, current_schema(), 'USAGE')
      END AS "hasSchemaUsage",
      CASE
        WHEN current_schema() IS NULL THEN NULL
        ELSE has_schema_privilege(current_user, current_schema(), 'CREATE')
      END AS "hasSchemaCreate"
  `

  const diagnostics: ServicePgStartupDiagnostics = {
    currentDatabase: context.currentDatabase,
    currentUser: context.currentUser,
    currentSchema: context.currentSchema,
    searchPath: context.searchPath,
    hasDatabaseCreate: privileges.hasDatabaseCreate,
    hasSchemaUsage: privileges.hasSchemaUsage,
    hasSchemaCreate: privileges.hasSchemaCreate,
  }

  const failures: string[] = []
  if (!diagnostics.currentSchema) {
    failures.push('search_path does not resolve to an existing schema')
  }
  if (!diagnostics.hasDatabaseCreate) {
    failures.push('database CREATE privilege is missing')
  }
  if (diagnostics.hasSchemaUsage !== true) {
    failures.push('schema USAGE privilege is missing')
  }
  if (diagnostics.hasSchemaCreate !== true) {
    failures.push('schema CREATE privilege is missing')
  }

  if (failures.length > 0) {
    throw new Error(
      `PostgreSQL startup preflight failed: ${failures.join('; ')}. ${formatStartupDiagnostics(diagnostics)}`,
    )
  }

  return diagnostics
}

async function executeMigrationStep(
  db: ServicePgDb,
  name: string,
  statement: ReturnType<typeof sql>,
): Promise<void> {
  try {
    await db.execute(statement)
  } catch (error) {
    let diagnosticSuffix = ''
    try {
      const diagnostics = await checkServicePgDbStartup(db)
      diagnosticSuffix = `; startup diagnostics: ${formatStartupDiagnostics(diagnostics)}`
    } catch (diagnosticError) {
      diagnosticSuffix = `; startup diagnostics failed: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`
    }

    const errorDetails = extractPgErrorDetails(error)
    throw new Error(
      `Failed to migrate PostgreSQL service table ${name}: ${error instanceof Error ? error.message : String(error)}${errorDetails ? `; postgres details: ${errorDetails}` : ''}${diagnosticSuffix}`,
      { cause: error },
    )
  }
}

export async function migrateServicePgDb(db: ServicePgDb): Promise<void> {
  await executeMigrationStep(
    db,
    'oauth_session',
    sql`
      CREATE TABLE IF NOT EXISTS "oauth_session" (
        "key" TEXT PRIMARY KEY,
        "session" TEXT NOT NULL,
        "createdAt" TEXT NOT NULL,
        "updatedAt" TEXT NOT NULL
      )
    `,
  )

  await executeMigrationStep(
    db,
    'oauth_state',
    sql`
      CREATE TABLE IF NOT EXISTS "oauth_state" (
        "key" TEXT PRIMARY KEY,
        "state" TEXT NOT NULL,
        "createdAt" TEXT NOT NULL
      )
    `,
  )

  await executeMigrationStep(
    db,
    'enrollment',
    sql`
      CREATE TABLE IF NOT EXISTS "enrollment" (
        "did" TEXT PRIMARY KEY,
        "enrolledAt" TEXT NOT NULL,
        "pdsEndpoint" TEXT,
        "signingKeyDid" TEXT NOT NULL,
        "active" TEXT NOT NULL DEFAULT 'true'
      )
    `,
  )

  await executeMigrationStep(
    db,
    'enrollment_boundary',
    sql`
      CREATE TABLE IF NOT EXISTS "enrollment_boundary" (
        "did" TEXT NOT NULL,
        "boundary" TEXT NOT NULL,
        PRIMARY KEY ("did", "boundary")
      )
    `,
  )

  await executeMigrationStep(
    db,
    'enrollment_boundary_did_idx',
    sql`
      CREATE INDEX IF NOT EXISTS "enrollment_boundary_did_idx" ON "enrollment_boundary"("did")
    `,
  )
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function closeServicePgDb(db: ServicePgDb): Promise<void> {
  await db.$client.end()
}
