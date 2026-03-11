export interface StratosConfig {
  /** Environment name (e.g. "production", "staging") */
  environment: string

  /** Route53 hosted zone domain (e.g. "example.com") */
  domainName: string
  /** Route53 hosted zone ID — if omitted, looked up by domainName */
  hostedZoneId?: string

  /** Subdomain for the Stratos API (e.g. "stratos" → stratos.example.com) */
  stratosSubdomain: string
  /** Subdomain for the webapp (e.g. "app" → app.example.com) */
  webappSubdomain: string

  /** Stratos service environment variables */
  stratos: {
    serviceDid: string
    publicUrl: string
    serviceFragment?: string
    allowedDomains: string
    retentionDays?: string
    enrollmentMode?: string
    allowedDids?: string
    allowedPdsEndpoints?: string
    plcUrl?: string
    signingKeyHex?: string
    oauthClientId?: string
    oauthClientSecret?: string
    oauthClientName?: string
    oauthLogoUri?: string
    oauthTosUri?: string
    oauthPolicyUri?: string
    repoUrl?: string
    operatorContact?: string
    logLevel?: string
    devMode?: string
    blobStorage?: string
  }

  /** Webapp build-time environment variables */
  webapp: {
    stratosUrl: string
  }

  /** Storage backend: 'sqlite' uses EFS, 'postgres' uses RDS */
  storageBackend?: 'sqlite' | 'postgres'

  /** RDS Postgres config (required when storageBackend is 'postgres') */
  postgres?: {
    instanceClass?: string
    allocatedStorageGiB?: number
    databaseName?: string
  }

  /** ECS task sizing */
  stratosTaskCpu?: number
  stratosTaskMemory?: number
  webappTaskCpu?: number
  webappTaskMemory?: number

  /** Desired task counts */
  stratosDesiredCount?: number
  webappDesiredCount?: number
}

export function resolveConfigFromEnv(): StratosConfig {
  function required(name: string): string {
    const val = process.env[name]
    if (!val) throw new Error(`Missing required env var: ${name}`)
    return val
  }
  function optional(name: string): string | undefined {
    return process.env[name] || undefined
  }

  return {
    environment: required('STRATOS_ENVIRONMENT'),
    domainName: required('STRATOS_DOMAIN_NAME'),
    stratosSubdomain: required('STRATOS_SUBDOMAIN'),
    webappSubdomain: required('STRATOS_WEBAPP_SUBDOMAIN'),
    stratos: {
      serviceDid: required('STRATOS_SERVICE_DID'),
      publicUrl: required('STRATOS_PUBLIC_URL'),
      allowedDomains: required('STRATOS_ALLOWED_DOMAINS'),
      enrollmentMode: optional('STRATOS_ENROLLMENT_MODE'),
    },
    webapp: {
      stratosUrl: required('STRATOS_WEBAPP_STRATOS_URL'),
    },
  }
}

export async function resolveConfig(): Promise<StratosConfig> {
  try {
    const mod = await import('../conf/config.ts')
    return mod.default satisfies StratosConfig
  } catch {
    return resolveConfigFromEnv()
  }
}
