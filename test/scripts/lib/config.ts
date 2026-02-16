// Test configuration — all constants for the E2E suite
// Load from .env file in the scripts directory

import { load } from 'jsr:@std/dotenv'

import { loadState } from './state.ts'
export { loadState }

const envPath = new URL('../.env', import.meta.url).pathname
await load({ envPath, export: true })

const state = await loadState()

// Use the ngrok URL from state if available, otherwise fall back to environment or default.
// This is critical because some scripts (like run-all.ts) might be imported by others
// before the Ngrok phase has completed. However, since each phase runs in its own
// process, this `loadState()` will re-run and pick up the correct URL.
export const STRATOS_URL =
  state.ngrokUrl || Deno.env.get('STRATOS_URL') || 'http://localhost:3100'

function requireEnv(key: string): string {
  const value = Deno.env.get(key)
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return value
}

export const PDS_HOST = requireEnv('PDS_HOST')
export const PDS_URL = `https://${PDS_HOST}`
export const PDS_ADMIN_PASSWORD = requireEnv('PDS_ADMIN_PASSWORD')

export const DOMAINS = {
  swordsmith: 'swordsmith',
  aekea: 'aekea',
} as const

// Random suffix to avoid handle conflicts with previously created accounts
const TEST_RUN_ID = Math.floor(Math.random() * 100000)
  .toString()
  .padStart(5, '0')

export interface TestUser {
  name: string
  handle: string
  email: string
  password: string
  /** Boundaries this user should have after configuration */
  boundaries: string[]
  /** Populated after account creation */
  did?: string
}

export const TEST_USERS: Record<string, TestUser> = {
  rei: {
    name: 'Rei',
    handle: `rei-${TEST_RUN_ID}.${PDS_HOST}`,
    email: `tachikoma+rei-${TEST_RUN_ID}@chipnick.com`,
    password: 'test-rei-stratos-2026!',
    boundaries: [DOMAINS.swordsmith],
  },
  sakura: {
    name: 'Sakura',
    handle: `sakura-${TEST_RUN_ID}.${PDS_HOST}`,
    email: `tachikoma+sakura-${TEST_RUN_ID}@chipnick.com`,
    password: 'test-sakura-stratos-2026!',
    boundaries: [DOMAINS.swordsmith],
  },
  kaoruko: {
    name: 'kaoruko',
    handle: `kaoruko-${TEST_RUN_ID}.${PDS_HOST}`,
    email: `tachikoma+kaoruko-${TEST_RUN_ID}@chipnick.com`,
    password: 'test-kaoruko-stratos-2026!',
    boundaries: [DOMAINS.aekea],
  },
}

export const STATE_FILE = new URL('./test-state.json', import.meta.url).pathname
export const TEST_DATA_DIR = new URL('../../../test-data', import.meta.url)
  .pathname
export const PROJECT_ROOT = new URL('../../..', import.meta.url).pathname
