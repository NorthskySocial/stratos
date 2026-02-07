// Direct SQLite access to the Stratos service database for boundary management.
// Uses Deno's FFI-based SQLite via jsr:@db/sqlite.

import { Database } from "jsr:@db/sqlite@0.12";
import { TEST_DATA_DIR } from "./config.ts";

const SERVICE_DB_PATH = `${TEST_DATA_DIR}/service.sqlite`;

function openDb(): Database {
  return new Database(SERVICE_DB_PATH);
}

/** Replace all boundaries for a user */
export function setBoundaries(did: string, boundaries: string[]): void {
  const db = openDb();
  try {
    db.exec("DELETE FROM enrollment_boundary WHERE did = ?", [did]);
    const stmt = db.prepare(
      "INSERT INTO enrollment_boundary (did, boundary) VALUES (?, ?)",
    );
    for (const boundary of boundaries) {
      stmt.run(did, boundary);
    }
    stmt.finalize();
  } finally {
    db.close();
  }
}

/** Get all boundaries for a user */
export function getBoundaries(did: string): string[] {
  const db = openDb();
  try {
    const rows = db.prepare(
      "SELECT boundary FROM enrollment_boundary WHERE did = ?",
    ).all(did) as Array<{ boundary: string }>;
    return rows.map((r) => r.boundary);
  } finally {
    db.close();
  }
}

/** Check if a user is enrolled */
export function isEnrolled(did: string): boolean {
  const db = openDb();
  try {
    const rows = db.prepare(
      "SELECT did FROM enrollment WHERE did = ?",
    ).all(did) as Array<{ did: string }>;
    return rows.length > 0;
  } finally {
    db.close();
  }
}

/** List all enrolled users */
export function listEnrolled(): Array<{ did: string; enrolledAt: string }> {
  const db = openDb();
  try {
    return db.prepare("SELECT did, enrolledAt FROM enrollment").all() as Array<{
      did: string;
      enrolledAt: string;
    }>;
  } finally {
    db.close();
  }
}
