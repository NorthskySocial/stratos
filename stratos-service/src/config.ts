import { z } from 'zod'

/**
 * Environment variable schema for stratos service
 */
const envSchema = z.object({
  // Service identity
  STRATOS_SERVICE_DID: z.string().min(1),
  /** Fragment for service entry in DID document (e.g., 'atproto_pns') */
  STRATOS_SERVICE_FRAGMENT: z.string().default('atproto_pns'),
  STRATOS_PORT: z.coerce.number().int().positive().default(3100),
  STRATOS_PUBLIC_URL: z.url(),

  // Storage
  STRATOS_DATA_DIR: z.string().default('./data'),
  STORAGE_BACKEND: z.enum(['sqlite', 'postgres']).default('sqlite'),
  STRATOS_POSTGRES_URL: z.string().optional(),
  STRATOS_PG_HOST: z.string().optional(),
  STRATOS_PG_PORT: z.coerce.number().int().positive().optional(),
  STRATOS_PG_USERNAME: z.string().optional(),
  STRATOS_PG_PASSWORD: z.string().optional(),
  STRATOS_PG_DBNAME: z.string().optional(),
  STRATOS_BLOB_STORAGE: z.enum(['local', 's3']).default('local'),

  // S3 storage (optional)
  STRATOS_S3_BUCKET: z.string().optional(),
  STRATOS_S3_REGION: z.string().optional(),
  STRATOS_S3_ENDPOINT: z.string().optional(),
  STRATOS_S3_ACCESS_KEY: z.string().optional(),
  STRATOS_S3_SECRET_KEY: z.string().optional(),

  // Stratos namespace config
  STRATOS_ALLOWED_DOMAINS: z.string().transform((s) =>
    s
      .split(',')
      .map((d) => d.trim())
      .filter((d) => d.length > 0),
  ),
  STRATOS_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  // Enrollment
  STRATOS_ENROLLMENT_MODE: z.enum(['open', 'allowlist']).default('allowlist'),
  STRATOS_ALLOWED_DIDS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((d) => d.trim())
        .filter((d) => d.length > 0),
    ),
  STRATOS_ALLOWED_PDS_ENDPOINTS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((d) => d.trim())
        .filter((d) => d.length > 0),
    ),

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

  // Logging
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error'])
    .default('info'),

  // Admin auth (optional)
  STRATOS_ADMIN_PASSWORD: z.string().optional(),

  // Dev mode (allows Bearer DID auth without DPoP for test scripts)
  STRATOS_DEV_MODE: z.coerce.boolean().default(false),

  // DPoP configuration
  STRATOS_DPOP_REQUIRE_NONCE: z.coerce.boolean().default(true),

  // User-Agent
  STRATOS_REPO_URL: z
    .string()
    .default('https://github.com/NorthskySocial/stratos'),
  STRATOS_OPERATOR_CONTACT: z
    .string()
    .optional()
    .transform((v) => v || undefined),
})

export type Env = z.infer<typeof envSchema>

/**
 * Parse and validate environment variables
 */
export function parseEnv(): Env {
  return envSchema.parse(process.env)
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
  }
  blobstore: BlobstoreConfig
  stratos: {
    allowedDomains: string[]
    retentionDays: number
    devMode?: boolean
    importMaxBytes: number
  }
  enrollment: {
    mode: 'open' | 'allowlist'
    allowedDids: string[]
    allowedPdsEndpoints: string[]
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

function buildPostgresUrl(env: Env): string | undefined {
  const {
    STRATOS_PG_HOST,
    STRATOS_PG_PORT,
    STRATOS_PG_USERNAME,
    STRATOS_PG_PASSWORD,
    STRATOS_PG_DBNAME,
  } = env
  if (!STRATOS_PG_HOST) return undefined
  const user = encodeURIComponent(STRATOS_PG_USERNAME ?? 'stratos')
  const pass = STRATOS_PG_PASSWORD
    ? `:${encodeURIComponent(STRATOS_PG_PASSWORD)}`
    : ''
  const port = STRATOS_PG_PORT ?? 5432
  const dbname = STRATOS_PG_DBNAME ?? 'stratos'
  return `postgres://${user}${pass}@${STRATOS_PG_HOST}:${port}/${dbname}`
}

export function envToConfig(env: Env): StratosServiceConfig {
  return {
    service: {
      did: env.STRATOS_SERVICE_DID,
      serviceFragment: env.STRATOS_SERVICE_FRAGMENT,
      port: env.STRATOS_PORT,
      publicUrl: env.STRATOS_PUBLIC_URL,
      repoUrl: env.STRATOS_REPO_URL,
    },
    storage: {
      backend: env.STORAGE_BACKEND,
      dataDir: env.STRATOS_DATA_DIR,
      postgresUrl: env.STRATOS_POSTGRES_URL ?? buildPostgresUrl(env),
    },
    blobstore: buildBlobstoreConfig(env),
    stratos: {
      allowedDomains: env.STRATOS_ALLOWED_DOMAINS,
      retentionDays: env.STRATOS_RETENTION_DAYS,
      devMode: env.STRATOS_DEV_MODE,
      importMaxBytes: env.STRATOS_IMPORT_MAX_BYTES,
    },
    enrollment: {
      mode: env.STRATOS_ENROLLMENT_MODE,
      allowedDids: env.STRATOS_ALLOWED_DIDS,
      allowedPdsEndpoints: env.STRATOS_ALLOWED_PDS_ENDPOINTS,
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
 */
export function getServiceDidWithFragment(
  config: StratosServiceConfig,
): string {
  return `${config.service.did}#${config.service.serviceFragment}`
}
