// Direct SQLite access to the Stratos service database for boundary management.
// Uses Deno's FFI-based SQLite via jsr:@db/sqlite.

import { Database } from "jsr:@db/sqlite@0.12";
import { TEST_DATA_DIR } from "./config.ts";
import { createHash } from "node:crypto";

const SERVICE_DB_PATH = `${TEST_DATA_DIR}/service.sqlite`;
const ACTORS_DIR = `${TEST_DATA_DIR}/actors`;

function openDb(): Database {
  return new Database(SERVICE_DB_PATH);
}

/** Compute SHA-256 hex hash of a string */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Get the actor directory path for a DID */
function getActorDir(did: string): string {
  const hash = sha256Hex(did);
  return `${ACTORS_DIR}/${hash.slice(0, 2)}/${did}`;
}

/** Enroll a user directly in the database */
export function enrollUser(
  did: string,
  pdsEndpoint?: string,
  boundaries?: string[],
): void {
  const db = openDb();
  try {
    const enrolledAt = new Date().toISOString();
    db.exec(
      `INSERT INTO enrollment (did, enrolledAt, pdsEndpoint) VALUES (?, ?, ?)
       ON CONFLICT(did) DO UPDATE SET enrolledAt = excluded.enrolledAt, pdsEndpoint = excluded.pdsEndpoint`,
      [did, enrolledAt, pdsEndpoint ?? null],
    );

    if (boundaries && boundaries.length > 0) {
      db.exec("DELETE FROM enrollment_boundary WHERE did = ?", [did]);
      const stmt = db.prepare(
        "INSERT INTO enrollment_boundary (did, boundary) VALUES (?, ?)",
      );
      for (const boundary of boundaries) {
        stmt.run(did, boundary);
      }
      stmt.finalize();
    }
  } finally {
    db.close();
  }
}

/** Create the actor store directory and initialize the SQLite database */
export async function createActorStore(did: string): Promise<void> {
  const actorDir = getActorDir(did);
  const dbPath = `${actorDir}/stratos.sqlite`;

  // Create directory
  await Deno.mkdir(actorDir, { recursive: true });

  // Check if database already exists
  try {
    await Deno.stat(dbPath);
    return; // Already exists
  } catch {
    // Does not exist, create it
  }

  // Create and initialize the actor database with schema
  const db = new Database(dbPath);
  try {
    db.exec(`
      -- Repo root (current state)
      CREATE TABLE IF NOT EXISTS stratos_repo_root (
        did TEXT PRIMARY KEY,
        cid TEXT NOT NULL,
        rev TEXT NOT NULL,
        indexedAt TEXT NOT NULL
      );

      -- Record index
      CREATE TABLE IF NOT EXISTS stratos_record (
        uri TEXT PRIMARY KEY,
        cid TEXT NOT NULL,
        collection TEXT NOT NULL,
        rkey TEXT NOT NULL,
        repoRev TEXT NOT NULL,
        indexedAt TEXT NOT NULL,
        takedownRef TEXT
      );
      CREATE INDEX IF NOT EXISTS stratos_record_collection_idx ON stratos_record(collection);
      CREATE INDEX IF NOT EXISTS stratos_record_repo_rev_idx ON stratos_record(repoRev);
      CREATE INDEX IF NOT EXISTS stratos_record_cid_idx ON stratos_record(cid);

      -- Record boundaries
      CREATE TABLE IF NOT EXISTS stratos_record_boundary (
        uri TEXT NOT NULL,
        boundary TEXT NOT NULL,
        PRIMARY KEY (uri, boundary)
      );
      CREATE INDEX IF NOT EXISTS stratos_record_boundary_uri_idx ON stratos_record_boundary(uri);

      -- Blob metadata
      CREATE TABLE IF NOT EXISTS stratos_blob (
        cid TEXT PRIMARY KEY,
        mimeType TEXT NOT NULL,
        size INTEGER NOT NULL,
        tempKey TEXT,
        createdAt TEXT NOT NULL
      );

      -- Blob-record relationship
      CREATE TABLE IF NOT EXISTS stratos_blob_record (
        blobCid TEXT NOT NULL,
        recordUri TEXT NOT NULL,
        PRIMARY KEY (blobCid, recordUri)
      );

      -- Backlinks
      CREATE TABLE IF NOT EXISTS stratos_backlink (
        uri TEXT NOT NULL,
        path TEXT NOT NULL,
        linkTo TEXT NOT NULL,
        PRIMARY KEY (uri, path)
      );
      CREATE INDEX IF NOT EXISTS stratos_backlink_link_to_idx ON stratos_backlink(path, linkTo);

      -- Repo blocks (MST)
      CREATE TABLE IF NOT EXISTS stratos_repo_block (
        cid TEXT PRIMARY KEY,
        repoRev TEXT NOT NULL,
        size INTEGER NOT NULL,
        content BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS stratos_repo_block_rev_idx ON stratos_repo_block(repoRev);
      CREATE INDEX IF NOT EXISTS stratos_repo_block_repo_rev_idx ON stratos_repo_block(repoRev, cid);

      -- Sequencer
      CREATE TABLE IF NOT EXISTS stratos_seq (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        did TEXT NOT NULL,
        eventType TEXT NOT NULL,
        event BLOB NOT NULL,
        sequencedAt TEXT NOT NULL,
        invalidated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS stratos_seq_did_idx ON stratos_seq(did);
      CREATE INDEX IF NOT EXISTS stratos_seq_sequenced_at_idx ON stratos_seq(sequencedAt);
    `);
  } finally {
    db.close();
  }
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
