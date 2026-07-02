import { z } from 'zod'
import {
  commaListSchema,
  dbConfigSchema,
  ENROLLMENT_MODE,
  InvalidServiceEnrollmentError,
  isValidSkey,
  loggingConfigSchema,
  qualifyBoundary,
  qualifyBoundaries,
  redisConfigSchema,
  validateServiceEnrollments,
  type RawServiceEnrollment,
  type ServiceEnrollment,
} from '@northskysocial/stratos-core'
import { readFileSync } from 'node:fs'
import {
  validateSpaceAppAccess,
  type RawSpaceAppAccess,
  type SpaceAppAccessConfig,
} from './features/space-credential/app-access.js'

/**
 * Environment variable schema for stratos service
 */
const envSchema = z
  .object({
    // Service identity
    STRATOS_SERVICE_DID: z.string().min(1),
    /** Fragment for service entry in DID document (e.g., 'atproto_pns') */
    STRATOS_SERVICE_FRAGMENT: z.string().default('atproto_pns'),
    STRATOS_PORT: z.coerce.number().int().positive().default(3100),
    STRATOS_PUBLIC_URL: z.string().url().default('http://localhost:3100'),

    STRATOS_BLOCK_CACHE_SIZE: z.coerce.number().int().positive().optional(),
    STRATOS_BLOB_STORAGE: z.enum(['local', 's3']).default('local'),

    // S3 storage (optional)
    STRATOS_S3_BUCKET: z.string().optional(),
    STRATOS_S3_REGION: z.string().optional(),
    STRATOS_S3_ENDPOINT: z.string().optional(),
    STRATOS_S3_ACCESS_KEY: z.string().optional(),
    STRATOS_S3_SECRET_KEY: z.string().optional(),

    // Stratos namespace config
    STRATOS_ALLOWED_DOMAINS: commaListSchema,
    STRATOS_AUTO_ENROLL_DOMAINS: commaListSchema,
    /**
     * Reserved all-members domain (bare name). Force-included in every
     * enrollment's boundary set; must also appear in STRATOS_ALLOWED_DOMAINS.
     */
    STRATOS_RESERVED_DOMAIN: z.string().min(1).default('general'),
    STRATOS_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
    STRATOS_WRITE_RATE_MAX_WRITES: z.coerce
      .number()
      .int()
      .positive()
      .default(300),
    STRATOS_WRITE_RATE_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000),
    STRATOS_WRITE_RATE_COOLDOWN_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(10_000),
    STRATOS_WRITE_RATE_COOLDOWN_JITTER_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(1_000),
    /** Space-credential lifetime in seconds (default 7200 = 2h per spec). */
    STRATOS_SPACE_CREDENTIAL_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(7_200),

    // Enrollment
    STRATOS_ENROLLMENT_MODE: z
      .enum(ENROLLMENT_MODE)
      .default(ENROLLMENT_MODE.ALLOWLIST),
    STRATOS_ALLOWED_DIDS: commaListSchema,
    STRATOS_ALLOWED_PDS_ENDPOINTS: commaListSchema,

    // Service enrollments (config-driven, reconciled on startup)
    STRATOS_SERVICE_ENROLLMENTS_FILE: z
      .string()
      .optional()
      .transform((v) => v || undefined),
    STRATOS_SERVICE_ENROLLMENTS: z
      .string()
      .optional()
      .transform((v) => v || undefined),

    // Per-space app-gating (client attestation, SWP-08). JSON array mapping a
    // space (skey/domainName) to an appAccess policy (`open` default, or
    // `allowList` of client_ids). Mirrors the service-enrollment mechanism.
    STRATOS_SPACE_APP_ACCESS_FILE: z
      .string()
      .optional()
      .transform((v) => v || undefined),
    STRATOS_SPACE_APP_ACCESS: z
      .string()
      .optional()
      .transform((v) => v || undefined),
    /** External-client JWKS cache TTL (ms) for client attestation. */
    STRATOS_CLIENT_JWKS_CACHE_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(300_000),

    // Repo import
    STRATOS_IMPORT_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(256 * 1024 * 1024),

    // Signing key
    STRATOS_SIGNING_KEY_HEX: z
      .string()
      .optional()
      .transform((v) => v || undefined),

    // OAuth
    STRATOS_OAUTH_CLIENT_ID: z
      .string()
      .optional()
      .transform((v) => v || undefined),
    STRATOS_OAUTH_CLIENT_SECRET: z
      .string()
      .optional()
      .transform((v) => v || undefined),
    STRATOS_OAUTH_CLIENT_NAME: z
      .string()
      .optional()
      .transform((v) => v || undefined),
    STRATOS_OAUTH_LOGO_URI: z
      .string()
      .optional()
      .transform((v) => v || undefined),
    STRATOS_OAUTH_TOS_URI: z
      .string()
      .optional()
      .transform((v) => v || undefined),
    STRATOS_OAUTH_POLICY_URI: z
      .string()
      .optional()
      .transform((v) => v || undefined),

    // PLC directory
    STRATOS_PLC_URL: z.string().url().default('https://plc.directory'),

    // Admin auth (optional)
    STRATOS_ADMIN_PASSWORD: z.string().optional(),
    // External allowlist (optional)
    STRATOS_ALLOW_LIST_URI: z.string().url().optional(),
    STRATOS_VALKEY_URL: z.string().url().optional(),
    STRATOS_ALLOW_LIST_BOOTSTRAP_NAME: z.string().optional(),

    // Dev mode (allows Bearer DID auth without DPoP for test scripts)
    STRATOS_DEV_MODE: z.coerce.boolean().default(false),

    // DPoP configuration
    STRATOS_DPOP_REQUIRE_NONCE: z.coerce.boolean().default(true),

    // User-Agent
    STRATOS_REPO_URL: z.string().default('http://localhost:3100'),
    STRATOS_OPERATOR_CONTACT: z
      .string()
      .optional()
      .transform((v) => v || undefined),
  })
  .merge(dbConfigSchema)
  .merge(loggingConfigSchema)
  .merge(redisConfigSchema)

export type Env = z.infer<typeof envSchema>

/**
 * Parse and validate environment variables with clear error reporting
 */
export function parseEnv(): Env {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    console.error('❌ Configuration error: Invalid environment variables')
    result.error.issues.forEach((issue) => {
      const path = issue.path.join('.')
      console.error(`  - ${path}: ${issue.message}`)
    })
    process.exit(1)
  }
  return result.data
}

/**
 * Disk blobstore configuration
 */
export interface DiskBlobstoreConfig {
  provider: 'disk'
  location: string
  tempLocation?: string
  quarantineLocation?: string
}

/**
 * S3 blobstore configuration
 */
export interface S3BlobstoreConfig {
  provider: 's3'
  bucket: string
  region?: string
  endpoint?: string
  forcePathStyle?: boolean
  accessKeyId?: string
  secretAccessKey?: string
  pathPrefix?: string
  uploadTimeoutMs?: number
}

/**
 * Blobstore configuration (discriminated union)
 */
export type BlobstoreConfig = DiskBlobstoreConfig | S3BlobstoreConfig

/**
 * Service configuration
 */
export interface StratosServiceConfig {
  service: {
    did: string
    /** Fragment identifier for the service entry in DID document (default: 'atproto_pns') */
    serviceFragment: string
    port: number
    publicUrl: string
    repoUrl: string
  }
  storage: {
    backend: 'sqlite' | 'postgres'
    dataDir: string
    postgresUrl?: string
    pgActorPoolSize?: number
    pgAdminPoolSize?: number
    blockCacheSize?: number
  }
  blobstore: BlobstoreConfig
  stratos: {
    serviceDid: string
    allowedDomains: string[]
    /**
     * Service-qualified reserved all-members domain (e.g.
     * `did:web:stratos.example.com/general`). Force-included in every
     * enrollment's boundary set and guaranteed to be within `allowedDomains`.
     */
    reservedDomain: string
    retentionDays: number
    devMode?: boolean
    importMaxBytes: number
    writeRateLimit: {
      maxWrites: number
      windowMs: number
      cooldownMs: number
      cooldownJitterMs: number
    }
    /** Space-credential lifetime in seconds (`exp = iat + this`). */
    spaceCredentialTtlSeconds: number
    /**
     * Per-space app-gating (client attestation, SWP-08). Maps a space boundary
     * to its `appAccess` policy; unconfigured spaces default to `#open`.
     */
    spaceAppAccess: SpaceAppAccessConfig
    /** External-client JWKS cache TTL (ms) for client-attestation resolution. */
    clientJwksCacheTtlMs: number
  }
  enrollment: {
    mode: ENROLLMENT_MODE
    allowedDids: string[]
    allowedPdsEndpoints: string[]
    autoEnrollDomains?: string[]
    allowListUrl?: string
    allowListBootstrapName?: string
    valkeyUrl?: string
    serviceEnrollments: ServiceEnrollment[]
  }
  identity: {
    plcUrl: string
  }
  signingKeyHex?: string
  oauth: {
    clientId?: string
    clientSecret?: string
    clientName?: string
    logoUri?: string
    tosUri?: string
    policyUri?: string
  }
  logging: {
    level: string
  }
  admin?: {
    password: string
  }
  dpop: {
    requireNonce: boolean
  }
  userAgent: {
    repoUrl: string
    operatorContact?: string
  }
}

/**
 * Convert environment to config
 */
/**
 * Build blobstore config from environment
 */
function buildBlobstoreConfig(env: Env): BlobstoreConfig {
  if (env.STRATOS_BLOB_STORAGE === 's3') {
    if (!env.STRATOS_S3_BUCKET) {
      throw new Error(
        'STRATOS_S3_BUCKET is required when STRATOS_BLOB_STORAGE=s3',
      )
    }
    return {
      provider: 's3',
      bucket: env.STRATOS_S3_BUCKET,
      region: env.STRATOS_S3_REGION,
      endpoint: env.STRATOS_S3_ENDPOINT,
      accessKeyId: env.STRATOS_S3_ACCESS_KEY,
      secretAccessKey: env.STRATOS_S3_SECRET_KEY,
      pathPrefix: 'stratos/',
    }
  }
  return {
    provider: 'disk',
    location: `${env.STRATOS_DATA_DIR}/blobs`,
    tempLocation: `${env.STRATOS_DATA_DIR}/blobs/temp`,
    quarantineLocation: `${env.STRATOS_DATA_DIR}/blobs/quarantine`,
  }
}

/**
 * Build Postgres URL from environment variables.
 * @param env - Environment variables object
 * @returns Postgres URL string or undefined if required environment variables are missing
 */
function buildPostgresUrl(env: Env): string | undefined {
  const {
    STRATOS_PG_HOST,
    STRATOS_PG_PORT,
    STRATOS_PG_USERNAME,
    STRATOS_PG_PASSWORD,
    STRATOS_PG_DBNAME,
    STRATOS_PG_SSLMODE,
  } = env
  if (!STRATOS_PG_HOST) return undefined
  const user = encodeURIComponent(STRATOS_PG_USERNAME ?? 'stratos')
  const pass = STRATOS_PG_PASSWORD
    ? `:${encodeURIComponent(STRATOS_PG_PASSWORD)}`
    : ''
  const port = STRATOS_PG_PORT ?? 5432
  const dbname = STRATOS_PG_DBNAME ?? 'stratos'
  const url = new URL(
    `postgres://${user}${pass}@${STRATOS_PG_HOST}:${port}/${dbname}`,
  )
  url.searchParams.set('sslmode', STRATOS_PG_SSLMODE ?? 'require')
  return url.toString()
}

function derivePublicUrl(env: Env): string {
  let publicUrl = env.STRATOS_PUBLIC_URL
  if (
    env.STRATOS_DEV_MODE &&
    (!publicUrl ||
      publicUrl === 'https://stratos.example.com' ||
      publicUrl === 'http://localhost:3100' ||
      publicUrl === 'undefined')
  ) {
    // If we're in dev mode and using a default/placeholder URL,
    // check if we can see an NGROK URL in the environment
    if (
      process.env.VITE_STRATOS_URL &&
      process.env.VITE_STRATOS_URL !== 'undefined'
    ) {
      publicUrl = process.env.VITE_STRATOS_URL
    } else if (env.STRATOS_REPO_URL && env.STRATOS_REPO_URL.includes('ngrok')) {
      publicUrl = env.STRATOS_REPO_URL
    }
  }

  // Ensure publicUrl is a string, even if empty, to avoid 'undefined' string later
  return publicUrl ?? ''
}

/**
 * Define Service DID based on environment variables.
 * @param env - Environment variables object
 * @param publicUrl - Public URL derived from environment variables
 * @returns Service DID derived from environment variables
 */
function deriveServiceDid(env: Env, publicUrl: string): string {
  let serviceDid = env.STRATOS_SERVICE_DID
  if (
    env.STRATOS_DEV_MODE &&
    publicUrl.includes('ngrok') &&
    (serviceDid === 'did:web:localhost' ||
      serviceDid === 'did:web:stratos1.example.com' ||
      !serviceDid)
  ) {
    try {
      const url = new URL(publicUrl)
      serviceDid = `did:web:${encodeURIComponent(url.hostname)}`
    } catch {
      // Fallback to original if URL parsing fails
    }
  }
  return serviceDid
}

/**
 * Parse raw service-enrollment entries from a JSON source.
 * @param raw - JSON string expected to encode an array of entries.
 * @param source - Human-readable origin used in error messages.
 * @returns The parsed raw entries.
 */
function parseServiceEnrollmentJson(
  raw: string,
  source: string,
): RawServiceEnrollment[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new InvalidServiceEnrollmentError(
      `service enrollments from ${source} is not valid JSON`,
      { cause: err },
    )
  }
  if (!Array.isArray(parsed)) {
    throw new InvalidServiceEnrollmentError(
      `service enrollments from ${source} must be a JSON array`,
    )
  }
  return parsed as RawServiceEnrollment[]
}

/**
 * Load, merge and validate config-driven service enrollments.
 * Combines file and inline sources; duplicate DIDs across sources fail fast.
 * @param env - Environment variables object.
 * @param serviceDid - Bare service DID used to qualify boundaries.
 * @param allowedDomains - Qualified boundaries the service may grant.
 * @returns The validated service enrollments.
 */
function loadServiceEnrollments(
  env: Env,
  serviceDid: string,
  allowedDomains: string[],
): ServiceEnrollment[] {
  const raw: RawServiceEnrollment[] = []

  if (env.STRATOS_SERVICE_ENROLLMENTS_FILE) {
    let contents: string
    try {
      contents = readFileSync(env.STRATOS_SERVICE_ENROLLMENTS_FILE, 'utf8')
    } catch (err) {
      throw new InvalidServiceEnrollmentError(
        `failed to read service enrollments file "${env.STRATOS_SERVICE_ENROLLMENTS_FILE}"`,
        { cause: err },
      )
    }
    raw.push(
      ...parseServiceEnrollmentJson(
        contents,
        `file "${env.STRATOS_SERVICE_ENROLLMENTS_FILE}"`,
      ),
    )
  }

  if (env.STRATOS_SERVICE_ENROLLMENTS) {
    raw.push(
      ...parseServiceEnrollmentJson(
        env.STRATOS_SERVICE_ENROLLMENTS,
        'STRATOS_SERVICE_ENROLLMENTS',
      ),
    )
  }

  return validateServiceEnrollments(raw, { serviceDid, allowedDomains })
}

/**
 * Resolve and validate the reserved all-members domain at startup.
 *
 * The bare name must be a valid skey (it becomes the space `skey`), and its
 * service-qualified form must be within the allowed-domains set — otherwise the
 * reserved domain could never be granted to enrollments. Fails fast with a
 * clear message so a misconfiguration is caught at boot rather than at write
 * time.
 *
 * @param serviceDid - Bare service DID used to qualify the reserved name.
 * @param bareName - Reserved domain name from STRATOS_RESERVED_DOMAIN.
 * @param allowedDomains - Service-qualified allowed boundaries.
 * @returns The service-qualified reserved domain.
 */
function resolveReservedDomain(
  serviceDid: string,
  bareName: string,
  allowedDomains: string[],
): string {
  if (!isValidSkey(bareName)) {
    throw new Error(
      `STRATOS_RESERVED_DOMAIN "${bareName}" is not a valid domain skey (1-512 UTF-8 bytes, record-key syntax)`,
    )
  }
  const reservedDomain = qualifyBoundary(serviceDid, bareName)
  if (!allowedDomains.includes(reservedDomain)) {
    throw new Error(
      `STRATOS_RESERVED_DOMAIN "${bareName}" must be listed in STRATOS_ALLOWED_DOMAINS (expected qualified "${reservedDomain}" among [${allowedDomains.join(', ')}])`,
    )
  }
  return reservedDomain
}

/**
 * Load, merge and validate per-space app-gating (client attestation) config.
 * Combines file and inline JSON sources (identical mechanism to service
 * enrollments); duplicate spaces across sources fail fast.
 *
 * @param env - Environment variables object.
 * @param serviceDid - Service DID used to qualify space boundaries.
 * @returns The validated app-access config (empty ⇒ every space is `#open`).
 */
function loadSpaceAppAccess(
  env: Env,
  serviceDid: string,
): SpaceAppAccessConfig {
  const raw: RawSpaceAppAccess[] = []

  if (env.STRATOS_SPACE_APP_ACCESS_FILE) {
    let contents: string
    try {
      contents = readFileSync(env.STRATOS_SPACE_APP_ACCESS_FILE, 'utf8')
    } catch (err) {
      throw new InvalidServiceEnrollmentError(
        `failed to read space app-access file "${env.STRATOS_SPACE_APP_ACCESS_FILE}"`,
        { cause: err },
      )
    }
    raw.push(
      ...parseSpaceAppAccessJson(
        contents,
        `file "${env.STRATOS_SPACE_APP_ACCESS_FILE}"`,
      ),
    )
  }

  if (env.STRATOS_SPACE_APP_ACCESS) {
    raw.push(
      ...parseSpaceAppAccessJson(
        env.STRATOS_SPACE_APP_ACCESS,
        'STRATOS_SPACE_APP_ACCESS',
      ),
    )
  }

  return validateSpaceAppAccess(raw, serviceDid)
}

/**
 * Parse raw space app-access entries from a JSON source.
 * @param raw - JSON string expected to encode an array of entries.
 * @param source - Human-readable origin used in error messages.
 * @returns The parsed raw entries.
 */
function parseSpaceAppAccessJson(
  raw: string,
  source: string,
): RawSpaceAppAccess[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new InvalidServiceEnrollmentError(
      `space app-access from ${source} is not valid JSON`,
      { cause: err },
    )
  }
  if (!Array.isArray(parsed)) {
    throw new InvalidServiceEnrollmentError(
      `space app-access from ${source} must be a JSON array`,
    )
  }
  return parsed as RawSpaceAppAccess[]
}

export function envToConfig(env: Env): StratosServiceConfig {
  const publicUrl = derivePublicUrl(env)
  const serviceDid = deriveServiceDid(env, publicUrl)
  const allowedDomains = qualifyBoundaries(
    serviceDid,
    env.STRATOS_ALLOWED_DOMAINS,
  )
  const reservedDomain = resolveReservedDomain(
    serviceDid,
    env.STRATOS_RESERVED_DOMAIN,
    allowedDomains,
  )

  return {
    service: {
      did: serviceDid,
      serviceFragment: env.STRATOS_SERVICE_FRAGMENT,
      port: env.STRATOS_PORT,
      publicUrl,
      repoUrl: env.STRATOS_REPO_URL,
    },
    storage: {
      backend: env.STORAGE_BACKEND,
      dataDir: env.STRATOS_DATA_DIR,
      postgresUrl: env.STRATOS_POSTGRES_URL ?? buildPostgresUrl(env),
      pgActorPoolSize: env.STRATOS_PG_ACTOR_POOL_SIZE,
      pgAdminPoolSize: env.STRATOS_PG_ADMIN_POOL_SIZE,
      blockCacheSize: env.STRATOS_BLOCK_CACHE_SIZE,
    },
    blobstore: buildBlobstoreConfig(env),
    stratos: {
      serviceDid,
      allowedDomains,
      reservedDomain,
      retentionDays: env.STRATOS_RETENTION_DAYS,
      devMode: env.STRATOS_DEV_MODE,
      importMaxBytes: env.STRATOS_IMPORT_MAX_BYTES,
      writeRateLimit: {
        maxWrites: env.STRATOS_WRITE_RATE_MAX_WRITES,
        windowMs: env.STRATOS_WRITE_RATE_WINDOW_MS,
        cooldownMs: env.STRATOS_WRITE_RATE_COOLDOWN_MS,
        cooldownJitterMs: env.STRATOS_WRITE_RATE_COOLDOWN_JITTER_MS,
      },
      spaceCredentialTtlSeconds: env.STRATOS_SPACE_CREDENTIAL_TTL_SECONDS,
      spaceAppAccess: loadSpaceAppAccess(env, serviceDid),
      clientJwksCacheTtlMs: env.STRATOS_CLIENT_JWKS_CACHE_TTL_MS,
    },
    enrollment: {
      mode: env.STRATOS_ENROLLMENT_MODE,
      allowedDids: env.STRATOS_ALLOWED_DIDS,
      allowedPdsEndpoints: env.STRATOS_ALLOWED_PDS_ENDPOINTS,
      autoEnrollDomains:
        env.STRATOS_AUTO_ENROLL_DOMAINS.length > 0
          ? qualifyBoundaries(serviceDid, env.STRATOS_AUTO_ENROLL_DOMAINS)
          : undefined,
      allowListUrl: env.STRATOS_ALLOW_LIST_URI,
      allowListBootstrapName: env.STRATOS_ALLOW_LIST_BOOTSTRAP_NAME,
      valkeyUrl: env.STRATOS_VALKEY_URL,
      serviceEnrollments: loadServiceEnrollments(
        env,
        serviceDid,
        allowedDomains,
      ),
    },
    identity: {
      plcUrl: env.STRATOS_PLC_URL,
    },
    signingKeyHex: env.STRATOS_SIGNING_KEY_HEX,
    oauth: {
      clientId: env.STRATOS_OAUTH_CLIENT_ID,
      clientSecret: env.STRATOS_OAUTH_CLIENT_SECRET,
      clientName: env.STRATOS_OAUTH_CLIENT_NAME,
      logoUri: env.STRATOS_OAUTH_LOGO_URI,
      tosUri: env.STRATOS_OAUTH_TOS_URI,
      policyUri: env.STRATOS_OAUTH_POLICY_URI,
    },
    logging: {
      level: env.LOG_LEVEL,
    },
    admin: env.STRATOS_ADMIN_PASSWORD
      ? {
          password: env.STRATOS_ADMIN_PASSWORD,
        }
      : undefined,
    dpop: {
      requireNonce: env.STRATOS_DPOP_REQUIRE_NONCE,
    },
    userAgent: {
      repoUrl: env.STRATOS_REPO_URL,
      operatorContact: env.STRATOS_OPERATOR_CONTACT,
    },
  }
}

/**
 * Get the full service DID with fragment for use in source.service field
 * @example "did:plc:abc123#atproto_pns"
 *
 * @param config - StratosServiceConfig
 * @returns - Full service DID with fragment
 */
export function getServiceDidWithFragment(
  config: StratosServiceConfig,
): string {
  return `${config.service.did}#${config.service.serviceFragment}`
}
