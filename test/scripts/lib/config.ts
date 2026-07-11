// Test configuration — all constants for the E2E suite
// Load from .env file in the test directory

import { load } from 'jsr:@std/dotenv'

import { loadState } from './state.ts'

export { loadState }

const envPath = new URL('../../../.env', import.meta.url).pathname
await load({ envPath, export: true })

// Defined before the loadState() call below: state.ts imports STATE_FILE from
// this module (circular), so it must be initialized before loadState reads it,
// or the read hits the temporal dead zone, throws, and loadState silently
// falls back to empty state — baking the wrong SERVICE_DID into DOMAINS.
export const STATE_FILE = new URL('../../test-state.json', import.meta.url)
  .pathname

const state = await loadState()

// Use the ngrok URL from state if available, otherwise fall back to environment or default.
// This is critical because some scripts (like run-all.ts) might be imported by others
// before the Ngrok phase has completed. However, since each phase runs in its own
// process, this `loadState()` will re-run and pick up the correct URL.
export const STRATOS_URL =
  state.ngrokUrl || Deno.env.get('STRATOS_URL') || 'http://localhost:3100'

function deriveServiceDid(ngrokUrl?: string): string {
  if (ngrokUrl) return `did:web:${ngrokUrl.replace(/^https?:\/\//, '')}`
  return 'did:web:127.0.0.1%3A3100'
}

export const SERVICE_DID = state.serviceDid ?? deriveServiceDid(state.ngrokUrl)

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
  swordsmith: `${SERVICE_DID}/swordsmith`,
  aekea: `${SERVICE_DID}/aekea`,
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
  fuyuko: {
    name: 'Fuyuko',
    handle: `fuyuko-${TEST_RUN_ID}.${PDS_HOST}`,
    email: `tachikoma+fuyuko-${TEST_RUN_ID}@chipnick.com`,
    password: 'test-fuyuko-stratos-2026!',
    boundaries: [DOMAINS.swordsmith],
  },
  haruki: {
    name: 'Haruki',
    handle: `haruki-${TEST_RUN_ID}.${PDS_HOST}`,
    email: `tachikoma+haruki-${TEST_RUN_ID}@chipnick.com`,
    password: 'test-haruki-stratos-2026!',
    boundaries: [DOMAINS.aekea],
  },
}

export const TEST_ROOT = new URL('../..', import.meta.url).pathname
export const TEST_DATA_DIR = new URL('../../test-data', import.meta.url)
  .pathname

/**
 * E2E user dedicated as the admin operator for the admin-API phase. Chosen so it
 * is *not* mutated by the posts phase, keeping the admin phase decoupled. Its DID
 * is injected into `STRATOS_ADMIN_DIDS` at setup so the service trusts it.
 */
export const ADMIN_OPERATOR_KEY = 'haruki'

/**
 * E2E user whose boundaries the admin-API phase mutates. Also untouched by the
 * posts phase, so boundary churn here cannot perturb the post access-control
 * assertions.
 */
export const ADMIN_TARGET_KEY = 'fuyuko'
