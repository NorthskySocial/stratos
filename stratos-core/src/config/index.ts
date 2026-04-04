import { z } from 'zod'

export const dbConfigSchema = z.object({
  STORAGE_BACKEND: z.enum(['sqlite', 'postgres']).default('sqlite'),
  STRATOS_DATA_DIR: z.string().default('./data'),
  STRATOS_POSTGRES_URL: z.string().optional(),
  STRATOS_PG_HOST: z.string().optional(),
  STRATOS_PG_PORT: z.coerce.number().int().positive().optional(),
  STRATOS_PG_USERNAME: z.string().optional(),
  STRATOS_PG_PASSWORD: z.string().optional(),
  STRATOS_PG_DBNAME: z.string().optional(),
  STRATOS_PG_SSLMODE: z
    .enum(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'])
    .optional(),
  STRATOS_PG_ACTOR_POOL_SIZE: z.coerce.number().int().positive().optional(),
  STRATOS_PG_ADMIN_POOL_SIZE: z.coerce.number().int().positive().optional(),
})

export const loggingConfigSchema = z.object({
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
})

export const redisConfigSchema = z.object({
  REDIS_HOST: z.string().optional(),
  REDIS_PORT: z.coerce.number().int().positive().optional(),
  REDIS_PASSWORD: z.string().optional(),
})

export function parseCommaList(s: string): string[] {
  return s
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
}

export const commaListSchema = z.string().default('').transform(parseCommaList)
