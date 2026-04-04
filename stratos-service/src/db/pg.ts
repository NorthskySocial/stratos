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

/**
 * Create a PostgreSQL database connection for the service
 * @param connectionString - PostgreSQL connection string
 * @returns ServicePgDb instance
 */
export function createServicePgDb(connectionString: string): ServicePgDb {
  const client = postgres(connectionString, { max: 5, idle_timeout: 20 })
  return drizzle({ client, schema: pgSchema }) as unknown as ServicePgDb
}

/**
 * Format PostgreSQL startup diagnostics into a string
 * @param diagnostics - Startup diagnostics
 * @returns Formatted diagnostics string
 */
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

/**
 * Extract PostgreSQL error details from an error object
 * @param error - Error object
 * @returns Set of error details
 */
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

/**
 * Check PostgreSQL database startup and return diagnostics
 * @param db - ServicePgDb instance
 * @returns ServicePgStartupDiagnostics
 */
export async function checkServicePgDbStartup(
  db: ServicePgDb,
): Promise<ServicePgStartupDiagnostics> {
  const client = db.$client

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

/**
 * Execute a migration step against the PostgreSQL database
 * @param db - ServicePgDb instance
 * @param name - Migration step name
 * @param statement - SQL statement to execute
 */
async function executeMigrationStep(
  db: ServicePgDb,
  name: string,
  statement: ReturnType<typeof sql>,
): Promise<void> {
  try {
    await db.execute(statement)
  } catch (error) {
    const diagnosticSuffix = await (async () => {
      try {
        const diagnostics = await checkServicePgDbStartup(db)
        return `; startup diagnostics: ${formatStartupDiagnostics(diagnostics)}`
      } catch (diagnosticError) {
        return `; startup diagnostics failed: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`
      }
    })()

    const errorDetails = extractPgErrorDetails(error)
    const errorPrefix = `Failed to migrate PostgreSQL service table ${name}: `
    const errorMessage = error instanceof Error ? error.message : String(error)
    const details = errorDetails ? `; postgres details: ${errorDetails}` : ''
    throw new Error(
      `${errorPrefix}${errorMessage}${details}${diagnosticSuffix}`,
      {
        cause: error,
      },
    )
  }
}

/**
 * Migrate the PostgreSQL database schema for the service
 * @param db - ServicePgDb instance
 */
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
        "active" TEXT NOT NULL DEFAULT 'true',
        "enrollmentRkey" TEXT
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

  // Migration: add enrollmentRkey column if missing (for existing databases)
  await executeMigrationStep(
    db,
    'enrollment_add_enrollmentRkey',
    sql`ALTER TABLE "enrollment" ADD COLUMN IF NOT EXISTS "enrollmentRkey" TEXT`,
  )
}

/**
 * Close the PostgreSQL database connection
 * @param db - ServicePgDb instance
 */
export async function closeServicePgDb(db: ServicePgDb): Promise<void> {
  await db.$client.end()
}
