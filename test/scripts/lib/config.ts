// Test configuration — all constants for the E2E suite

export const PDS_URL = "https://pds.atverkackt.de";
export const PDS_ADMIN_PASSWORD = "7fb58d2665682d07903be59a90e0e2e2";
export const STRATOS_URL = "http://localhost:3100";

export const DOMAINS = {
  swordsmith: "swordsmith",
  aekea: "aekea",
} as const;

// Random suffix to avoid handle conflicts with previously created accounts
const TEST_RUN_ID = Math.floor(Math.random() * 100000).toString().padStart(5, "0");

export interface TestUser {
  name: string;
  handle: string;
  email: string;
  password: string;
  /** Boundaries this user should have after configuration */
  boundaries: string[];
  /** Populated after account creation */
  did?: string;
}

export const TEST_USERS: Record<string, TestUser> = {
  rei: {
    name: "Rei",
    handle: `rei-${TEST_RUN_ID}.pds.atverkackt.de`,
    email: `tachikoma+rei-${TEST_RUN_ID}@chipnick.com`,
    password: "test-rei-stratos-2026!",
    boundaries: [DOMAINS.swordsmith],
  },
  sakura: {
    name: "Sakura",
    handle: `sakura-${TEST_RUN_ID}.pds.atverkackt.de`,
    email: `tachikoma+sakura-${TEST_RUN_ID}@chipnick.com`,
    password: "test-sakura-stratos-2026!",
    boundaries: [DOMAINS.swordsmith],
  },
  kaoruko: {
    name: "kaoruko",
    handle: `kaoruko-${TEST_RUN_ID}.pds.atverkackt.de`,
    email: `tachikoma+kaoruko-${TEST_RUN_ID}@chipnick.com`,
    password: "test-kaoruko-stratos-2026!",
    boundaries: [DOMAINS.aekea],
  },
};

export const STATE_FILE = new URL("../../../test-data/test-state.json", import.meta.url).pathname;
export const TEST_DATA_DIR = new URL("../../../test-data", import.meta.url).pathname;
export const PROJECT_ROOT = new URL("../../..", import.meta.url).pathname;
