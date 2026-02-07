// Test configuration — all constants for the E2E suite

export const PDS_URL = "https://pds.atverkackt.de";
export const PDS_ADMIN_PASSWORD = "7fb58d2665682d07903be59a90e0e2e2";
export const STRATOS_URL = "http://localhost:3100";

export const DOMAINS = {
  swordsmith: "swordsmith",
  aekea: "aekea",
} as const;

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
    handle: "rei.pds.atverkackt.de",
    email: "rei@test.stratos.local",
    password: "test-rei-stratos-2026!",
    boundaries: [DOMAINS.swordsmith],
  },
  sakura: {
    name: "Sakura",
    handle: "sakura.pds.atverkackt.de",
    email: "sakura@test.stratos.local",
    password: "test-sakura-stratos-2026!",
    boundaries: [DOMAINS.swordsmith],
  },
  kaoruko: {
    name: "kaoruko",
    handle: "kaoruko.pds.atverkackt.de",
    email: "kaoruko@test.stratos.local",
    password: "test-kaoruko-stratos-2026!",
    boundaries: [DOMAINS.aekea],
  },
};

export const STATE_FILE = new URL("../../../test-data/test-state.json", import.meta.url).pathname;
export const TEST_DATA_DIR = new URL("../../../test-data", import.meta.url).pathname;
export const PROJECT_ROOT = new URL("../../..", import.meta.url).pathname;
