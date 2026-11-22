use rusqlite::{Connection, TransactionBehavior};

struct Migration {
    version: u32,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        sql: r#"
        CREATE TABLE schema_migration (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );

        CREATE TABLE post (
          uri TEXT PRIMARY KEY,
          author_did TEXT NOT NULL,
          cid TEXT NOT NULL,
          sort_at TEXT NOT NULL,
          indexed_at TEXT NOT NULL,
          retained_at TEXT NOT NULL,
          projection_bytes INTEGER NOT NULL CHECK (projection_bytes >= 0),
          record_json BLOB NOT NULL,
          blob_refs_json BLOB NOT NULL,
          row_version INTEGER NOT NULL CHECK (row_version >= 0)
        );
        CREATE INDEX post_author_uri_idx ON post(author_did, uri);
        CREATE INDEX post_feed_order_idx ON post(sort_at DESC, uri ASC);

        CREATE TABLE post_boundary (
          uri TEXT NOT NULL REFERENCES post(uri) ON DELETE CASCADE,
          boundary TEXT NOT NULL,
          sort_at TEXT NOT NULL,
          PRIMARY KEY (uri, boundary)
        ) WITHOUT ROWID;
        CREATE INDEX post_boundary_feed_idx
          ON post_boundary(boundary, sort_at DESC, uri ASC);

        CREATE TABLE membership_baseline (
          boundary TEXT NOT NULL,
          did TEXT NOT NULL,
          custody TEXT NOT NULL CHECK (custody IN ('pds', 'stratos')),
          repo_host TEXT,
          reconciled_at TEXT NOT NULL,
          PRIMARY KEY (boundary, did)
        ) WITHOUT ROWID;

        CREATE TABLE projection_epoch (
          scope TEXT PRIMARY KEY,
          epoch INTEGER NOT NULL CHECK (epoch >= 0),
          updated_at TEXT NOT NULL
        );

        CREATE TABLE actor_cursor (
          authority_did TEXT NOT NULL,
          did TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence >= 0),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (authority_did, did)
        ) WITHOUT ROWID;

        CREATE TABLE space_cursor (
          space_uri TEXT NOT NULL,
          did TEXT NOT NULL,
          cursor TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (space_uri, did)
        ) WITHOUT ROWID;

        CREATE TABLE space_sync_stage (
          space_uri TEXT NOT NULL,
          did TEXT NOT NULL,
          uri TEXT NOT NULL,
          boundary TEXT NOT NULL,
          deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
          cid TEXT,
          sort_at TEXT,
          indexed_at TEXT,
          record_json BLOB,
          blob_refs_json BLOB,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (space_uri, did, uri)
        ) WITHOUT ROWID;

        CREATE TABLE space_sync_pending_verification (
          space_uri TEXT NOT NULL,
          did TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (space_uri, did)
        ) WITHOUT ROWID;

        CREATE TABLE retention_metadata (
          key TEXT PRIMARY KEY,
          value INTEGER NOT NULL CHECK (value >= 0)
        );

        CREATE TABLE source_coverage (
          authority_did TEXT NOT NULL,
          source_id TEXT NOT NULL,
          boundary TEXT NOT NULL,
          start_sequence INTEGER NOT NULL CHECK (start_sequence >= 0),
          end_sequence INTEGER NOT NULL CHECK (end_sequence >= start_sequence),
          verified_at TEXT NOT NULL,
          PRIMARY KEY (authority_did, source_id, boundary, start_sequence)
        ) WITHOUT ROWID;
        CREATE INDEX source_coverage_boundary_idx ON source_coverage(boundary, source_id);

        CREATE TABLE suppression_marker (
          authority_did TEXT NOT NULL,
          source_id TEXT NOT NULL,
          uri TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence >= 0),
          PRIMARY KEY (authority_did, source_id, uri)
        ) WITHOUT ROWID;
        CREATE INDEX suppression_marker_source_sequence_idx
          ON suppression_marker(source_id, sequence);
    "#,
    },
    Migration {
        version: 2,
        sql: r#"
        ALTER TABLE space_cursor ADD COLUMN boundary TEXT NOT NULL DEFAULT '';
        ALTER TABLE space_sync_pending_verification ADD COLUMN boundary TEXT NOT NULL DEFAULT '';
        CREATE INDEX space_cursor_boundary_idx ON space_cursor(boundary, space_uri, did);
        CREATE INDEX space_sync_pending_verification_boundary_idx
          ON space_sync_pending_verification(boundary, space_uri, did);
    "#,
    },
    Migration {
        version: 3,
        sql: r#"
        CREATE TABLE actor_enrollment (
          did TEXT PRIMARY KEY,
          boundaries_json BLOB NOT NULL,
          observed_at TEXT NOT NULL,
          enrolled INTEGER NOT NULL CHECK (enrolled IN (0, 1))
        );
    "#,
    },
    Migration {
        version: 4,
        sql: r#"
        CREATE INDEX actor_enrollment_enrolled_did_idx
          ON actor_enrollment(enrolled, did);
    "#,
    },
    Migration {
        version: 5,
        sql: r#"
        CREATE TABLE space_sync_stage_cursor (
          space_uri TEXT NOT NULL,
          did TEXT NOT NULL,
          boundary TEXT NOT NULL,
          cursor TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (space_uri, did)
        ) WITHOUT ROWID;
        CREATE INDEX space_sync_stage_cursor_boundary_idx
          ON space_sync_stage_cursor(boundary, space_uri, did);

        INSERT INTO space_sync_stage_cursor (space_uri, did, boundary, cursor, updated_at)
          SELECT cursor.space_uri, cursor.did, cursor.boundary, cursor.cursor, cursor.updated_at
          FROM space_cursor AS cursor
          WHERE EXISTS (
            SELECT 1 FROM space_sync_stage AS stage
            WHERE stage.space_uri = cursor.space_uri AND stage.did = cursor.did
          );
        DELETE FROM space_cursor
          WHERE EXISTS (
            SELECT 1 FROM space_sync_stage AS stage
            WHERE stage.space_uri = space_cursor.space_uri AND stage.did = space_cursor.did
          );
    "#,
    },
    Migration {
        version: 6,
        sql: r#"
        CREATE TABLE pds_boundary_generation (
          boundary TEXT PRIMARY KEY,
          generation INTEGER NOT NULL CHECK (generation >= 0)
        ) WITHOUT ROWID;
        CREATE TABLE pds_member_generation (
          boundary TEXT NOT NULL,
          did TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK (generation >= 0),
          PRIMARY KEY (boundary, did)
        ) WITHOUT ROWID;
        INSERT INTO pds_member_generation (boundary, did, generation)
          SELECT boundary, did, 0 FROM membership_baseline WHERE custody = 'pds';
    "#,
    },
    Migration {
        version: 7,
        sql: r#"
        CREATE TABLE space_sync_stage_lifetime (
          space_uri TEXT NOT NULL,
          did TEXT NOT NULL,
          boundary TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_progress_at TEXT NOT NULL,
          PRIMARY KEY (space_uri, did)
        ) WITHOUT ROWID;
        CREATE INDEX space_sync_stage_lifetime_progress_idx
          ON space_sync_stage_lifetime(last_progress_at, created_at);
        INSERT INTO space_sync_stage_lifetime (space_uri, did, boundary, created_at, last_progress_at)
          SELECT space_uri, did, boundary, MIN(updated_at), MAX(updated_at)
          FROM (
            SELECT space_uri, did, boundary, updated_at FROM space_sync_stage
            UNION ALL
            SELECT space_uri, did, boundary, updated_at FROM space_sync_stage_cursor
            UNION ALL
            SELECT space_uri, did, boundary, updated_at FROM space_sync_pending_verification
          ) GROUP BY space_uri, did;
        CREATE TRIGGER stage_lifetime_after_stage_delete AFTER DELETE ON space_sync_stage
        BEGIN
          DELETE FROM space_sync_stage_lifetime WHERE space_uri = OLD.space_uri AND did = OLD.did
          AND NOT EXISTS (SELECT 1 FROM space_sync_stage WHERE space_uri = OLD.space_uri AND did = OLD.did)
          AND NOT EXISTS (SELECT 1 FROM space_sync_stage_cursor WHERE space_uri = OLD.space_uri AND did = OLD.did)
          AND NOT EXISTS (SELECT 1 FROM space_sync_pending_verification WHERE space_uri = OLD.space_uri AND did = OLD.did);
        END;
        CREATE TRIGGER stage_lifetime_after_cursor_delete AFTER DELETE ON space_sync_stage_cursor
        BEGIN
          DELETE FROM space_sync_stage_lifetime WHERE space_uri = OLD.space_uri AND did = OLD.did
          AND NOT EXISTS (SELECT 1 FROM space_sync_stage WHERE space_uri = OLD.space_uri AND did = OLD.did)
          AND NOT EXISTS (SELECT 1 FROM space_sync_stage_cursor WHERE space_uri = OLD.space_uri AND did = OLD.did)
          AND NOT EXISTS (SELECT 1 FROM space_sync_pending_verification WHERE space_uri = OLD.space_uri AND did = OLD.did);
        END;
        CREATE TRIGGER stage_lifetime_after_pending_delete AFTER DELETE ON space_sync_pending_verification
        BEGIN
          DELETE FROM space_sync_stage_lifetime WHERE space_uri = OLD.space_uri AND did = OLD.did
          AND NOT EXISTS (SELECT 1 FROM space_sync_stage WHERE space_uri = OLD.space_uri AND did = OLD.did)
          AND NOT EXISTS (SELECT 1 FROM space_sync_stage_cursor WHERE space_uri = OLD.space_uri AND did = OLD.did)
          AND NOT EXISTS (SELECT 1 FROM space_sync_pending_verification WHERE space_uri = OLD.space_uri AND did = OLD.did);
        END;
    "#,
    },
    // Label state belongs to the authority, not to membership, so unenroll and
    // source cleanup never clear it.
    Migration {
        version: 8,
        sql: r#"
        CREATE TABLE label_cursor (
          authority_did TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL CHECK (sequence >= 0),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE label_subject (
          authority_did TEXT NOT NULL,
          subject_key TEXT NOT NULL,
          subject_kind TEXT NOT NULL CHECK (subject_kind IN ('record', 'account')),
          author_did TEXT NOT NULL,
          label_sequence INTEGER NOT NULL CHECK (label_sequence >= 0),
          state TEXT NOT NULL CHECK (state IN ('takedown', 'reinstating')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          PRIMARY KEY (authority_did, subject_key)
        ) WITHOUT ROWID;
        CREATE INDEX label_subject_author_idx ON label_subject(authority_did, author_did, state);
    "#,
    },
    Migration {
        version: 9,
        sql: r#"
        CREATE TABLE interaction (
          uri TEXT PRIMARY KEY,
          actor_did TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('like', 'repost')),
          subject_uri TEXT NOT NULL,
          boundary TEXT NOT NULL,
          indexed_at TEXT NOT NULL,
          retained_at TEXT NOT NULL,
          projection_bytes INTEGER NOT NULL CHECK (projection_bytes >= 0)
        ) WITHOUT ROWID;
        CREATE INDEX interaction_count_idx
          ON interaction(boundary, subject_uri, kind, actor_did);
        CREATE INDEX interaction_actor_idx ON interaction(actor_did, boundary);
        CREATE INDEX interaction_subject_idx ON interaction(subject_uri);
        CREATE INDEX interaction_retained_idx ON interaction(retained_at);
        -- Every removal of a post, whichever path takes it, removes its
        -- interactions in the same transaction; no deletion site can forget.
        CREATE TRIGGER interaction_after_post_delete AFTER DELETE ON post
        BEGIN
          DELETE FROM interaction WHERE subject_uri = OLD.uri;
        END;
    "#,
    },
    // The space URI spelling changed, so rows keyed by an earlier spelling can
    // never match again. Everything purged is derived and a verified sync
    // rebuilds it, which is why this deletes instead of rewriting URIs.
    Migration {
        version: 10,
        sql: r#"
        DELETE FROM interaction
          WHERE NOT (substr(uri, 1, 5) = 'at://' AND length(uri) - length(replace(uri, '/', '')) = 4)
             OR NOT (substr(subject_uri, 1, 5) = 'at://' AND length(subject_uri) - length(replace(subject_uri, '/', '')) = 4);

        DELETE FROM post_boundary
          WHERE NOT (substr(uri, 1, 5) = 'at://' AND length(uri) - length(replace(uri, '/', '')) = 4);
        DELETE FROM post
          WHERE NOT (substr(uri, 1, 5) = 'at://' AND length(uri) - length(replace(uri, '/', '')) = 4);

        DELETE FROM suppression_marker
          WHERE NOT (substr(uri, 1, 5) = 'at://' AND length(uri) - length(replace(uri, '/', '')) = 4);

        DELETE FROM space_sync_stage;
        DELETE FROM space_sync_stage_cursor;
        DELETE FROM space_sync_pending_verification;
        DELETE FROM space_sync_stage_lifetime;
        DELETE FROM space_cursor;

        DELETE FROM label_subject
          WHERE subject_kind = 'record'
            AND NOT (substr(subject_key, 1, 5) = 'at://' AND length(subject_key) - length(replace(subject_key, '/', '')) = 4);
        DELETE FROM label_cursor;

        CREATE TABLE space_repo_state (
          space_uri TEXT NOT NULL,
          did TEXT NOT NULL,
          boundary TEXT NOT NULL,
          host TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK (generation >= 0),
          rev TEXT NOT NULL,
          set_hash BLOB NOT NULL CHECK (length(set_hash) = 2048),
          record_count INTEGER NOT NULL CHECK (record_count >= 0),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (space_uri, did)
        );
        CREATE INDEX space_repo_state_boundary_idx ON space_repo_state(boundary, did);

        CREATE TABLE space_repo_record (
          space_uri TEXT NOT NULL,
          did TEXT NOT NULL,
          collection TEXT NOT NULL,
          rkey TEXT NOT NULL,
          boundary TEXT NOT NULL,
          cid TEXT NOT NULL,
          PRIMARY KEY (space_uri, did, collection, rkey)
        ) WITHOUT ROWID;
        CREATE INDEX space_repo_record_boundary_idx ON space_repo_record(boundary, did);
    "#,
    },
    // Pages are no longer staged: a poll proves its ops in memory and writes
    // once, so nothing reads these tables or their cursors again.
    Migration {
        version: 11,
        sql: r#"
        DROP TRIGGER stage_lifetime_after_stage_delete;
        DROP TRIGGER stage_lifetime_after_cursor_delete;
        DROP TRIGGER stage_lifetime_after_pending_delete;
        DROP TABLE space_sync_stage_lifetime;
        DROP TABLE space_sync_pending_verification;
        DROP TABLE space_sync_stage_cursor;
        DROP TABLE space_sync_stage;
        DROP TABLE space_cursor;
    "#,
    },
    // A cursor now records the boundaries it was read under; an existing one
    // has none, which reads as unknown and makes the first poll replay the log
    // once. A lifted subject keeps its row, so a replay can tell which labels
    // were already applied; the state check is rebuilt to admit it.
    Migration {
        version: 12,
        sql: r#"
        ALTER TABLE label_cursor ADD COLUMN scope_json TEXT;
        CREATE TABLE label_subject_rebuilt (
          authority_did TEXT NOT NULL,
          subject_key TEXT NOT NULL,
          subject_kind TEXT NOT NULL CHECK (subject_kind IN ('record', 'account')),
          author_did TEXT NOT NULL,
          label_sequence INTEGER NOT NULL CHECK (label_sequence >= 0),
          state TEXT NOT NULL CHECK (state IN ('takedown', 'reinstating', 'lifted')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          PRIMARY KEY (authority_did, subject_key)
        ) WITHOUT ROWID;
        INSERT INTO label_subject_rebuilt
          (authority_did, subject_key, subject_kind, author_did, label_sequence, state, attempts)
          SELECT authority_did, subject_key, subject_kind, author_did, label_sequence, state, attempts
          FROM label_subject;
        DROP TABLE label_subject;
        ALTER TABLE label_subject_rebuilt RENAME TO label_subject;
        CREATE INDEX label_subject_author_idx ON label_subject(authority_did, author_did, state);
    "#,
    },
];

pub(super) fn apply(connection: &mut Connection) -> rusqlite::Result<()> {
    apply_migrations(connection, MIGRATIONS)
}

/// Brings a database to an earlier version with the real migrations, for tests
/// of an upgrade.
#[cfg(test)]
pub(super) fn apply_through(connection: &mut Connection, version: usize) -> rusqlite::Result<()> {
    apply_migrations(connection, &MIGRATIONS[..version])
}

fn apply_migrations(connection: &mut Connection, migrations: &[Migration]) -> rusqlite::Result<()> {
    let latest_version = migrations.last().map_or(0, |migration| migration.version);
    for migration in migrations {
        let current_version: u32 =
            connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if current_version > latest_version {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if current_version >= migration.version {
            continue;
        }
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(migration.sql)?;
        transaction.execute(
            "INSERT INTO schema_migration (version, applied_at) VALUES (?1, unixepoch())",
            [migration.version],
        )?;
        transaction.pragma_update(None, "user_version", migration.version)?;
        transaction.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::{MIGRATIONS, Migration, apply, apply_migrations};

    const LAST_VERSION_BEFORE_PURGE: usize = 9;
    const LAST_VERSION_BEFORE_DROP: usize = 10;
    const LAST_VERSION_BEFORE_LABEL_SCOPE: usize = 11;

    #[test]
    fn initializes_the_versioned_projection_schema() {
        let mut connection = Connection::open_in_memory().unwrap();
        apply(&mut connection).unwrap();

        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 12);
        let migration_count: u32 = connection
            .query_row("SELECT COUNT(*) FROM schema_migration", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(migration_count, 12);
        let post_boundary_sql: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'post_boundary'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(post_boundary_sql.contains("REFERENCES post(uri) ON DELETE CASCADE"));
        let feed_index_sql: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'post_boundary_feed_idx'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(feed_index_sql.contains("boundary, sort_at DESC, uri ASC"));
    }

    #[test]
    fn upgrade_seeds_generations_for_existing_pds_members() {
        let mut connection = Connection::open_in_memory().unwrap();
        for migration in MIGRATIONS.iter().take(5) {
            connection.execute_batch(migration.sql).unwrap();
            connection
                .execute(
                    "INSERT INTO schema_migration (version, applied_at) VALUES (?1, unixepoch())",
                    [migration.version],
                )
                .unwrap();
            connection
                .pragma_update(None, "user_version", migration.version)
                .unwrap();
        }
        connection.execute(
            "INSERT INTO membership_baseline (boundary, did, custody, reconciled_at) VALUES (?1, ?2, 'pds', ?3)",
            rusqlite::params!["did:web:stratos.test/bebop", "did:plc:faye", "2026-09-22T00:00:00.000Z"],
        ).unwrap();

        apply(&mut connection).unwrap();

        let generation: i64 = connection
            .query_row(
                "SELECT generation FROM pds_member_generation WHERE boundary = ?1 AND did = ?2",
                rusqlite::params!["did:web:stratos.test/bebop", "did:plc:faye"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(generation, 0);
    }

    #[test]
    fn rolls_back_a_failed_migration_without_advancing_the_version() {
        let mut connection = Connection::open_in_memory().unwrap();
        let migration = Migration {
            version: 1,
            sql: "CREATE TABLE temporary_projection (id INTEGER); INVALID SQL;",
        };
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        assert!(transaction.execute_batch(migration.sql).is_err());
        transaction.rollback().unwrap();

        let table_count: u32 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'temporary_projection'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(table_count, 0);
        assert_eq!(version, 0);
    }

    #[test]
    fn migrates_existing_space_lifecycle_rows_to_unlabelled_state() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(super::MIGRATIONS[0].sql).unwrap();
        connection
            .execute(
                "INSERT INTO schema_migration (version, applied_at) VALUES (1, 0)",
                [],
            )
            .unwrap();
        connection.pragma_update(None, "user_version", 1).unwrap();
        connection
            .execute(
                "INSERT INTO space_cursor (space_uri, did, cursor, updated_at) VALUES (?1, ?2, ?3, ?4)",
                [
                    "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop",
                    "did:plc:spikespiegel",
                    "firehose:8",
                    "1998-04-03T00:00:00.000Z",
                ],
            )
            .unwrap();

        apply_migrations(&mut connection, &MIGRATIONS[..LAST_VERSION_BEFORE_PURGE]).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT boundary FROM space_cursor", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            ""
        );
    }

    #[test]
    fn keeps_preexisting_staged_cursors_uncommitted_during_upgrade() {
        let mut connection = Connection::open_in_memory().unwrap();
        for migration in &super::MIGRATIONS[..4] {
            connection.execute_batch(migration.sql).unwrap();
            connection
                .execute(
                    "INSERT INTO schema_migration (version, applied_at) VALUES (?1, 0)",
                    [migration.version],
                )
                .unwrap();
            connection
                .pragma_update(None, "user_version", migration.version)
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO space_cursor (space_uri, did, boundary, cursor, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                [
                    "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop",
                    "did:plc:spikespiegel",
                    "did:web:stratos.example/bebop",
                    "unverified",
                    "1998-04-03T00:00:00.000Z",
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO space_sync_stage (space_uri, did, uri, boundary, deleted, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)",
                [
                    "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop",
                    "did:plc:spikespiegel",
                    "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop/did:plc:spikespiegel/zone.stratos.feed.post/see-you",
                    "did:web:stratos.example/bebop",
                    "1998-04-03T00:00:00.000Z",
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO space_cursor (space_uri, did, boundary, cursor, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                [
                    "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop",
                    "did:plc:faye",
                    "did:web:stratos.example/bebop",
                    "verified",
                    "1998-04-03T00:00:00.000Z",
                ],
            )
            .unwrap();

        apply_migrations(&mut connection, &MIGRATIONS[..LAST_VERSION_BEFORE_PURGE]).unwrap();

        let committed: String = connection
            .query_row("SELECT cursor FROM space_cursor", [], |row| row.get(0))
            .unwrap();
        let staged: String = connection
            .query_row("SELECT cursor FROM space_sync_stage_cursor", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(committed, "verified");
        assert_eq!(staged, "unverified");
    }

    #[test]
    fn rejects_a_database_from_a_newer_store_format() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection.pragma_update(None, "user_version", 13).unwrap();

        assert!(apply(&mut connection).is_err());
    }

    // Migration 10: databases an older build wrote, brought to version 9 by the
    // real earlier migrations.

    use std::{collections::BTreeMap, fs, path::PathBuf};

    use rusqlite::{OpenFlags, params, types::Value};

    use crate::store::{EncryptedStore, PdsSpaceMember, StorageKey};

    const BOUNDARY: &str = "did:web:stratos.example/bebop";
    const SPACE: &str = "at:space/did:web:stratos.example/zone.stratos.space.feed/bebop";
    const LEGACY_SPACE: &str = "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop";
    const AUTHORITY: &str = "did:web:stratos.example";
    const SPIKE: &str = "did:plc:spikespiegel";
    const FAYE: &str = "did:plc:fayevalentine";
    const JET: &str = "did:plc:jetblack";
    const EDWARD: &str = "did:plc:edward";
    const SPIKE_POST: &str = "at://did:plc:spikespiegel/zone.stratos.feed.post/swordfish";
    const FAYE_POST: &str = "at://did:plc:fayevalentine/zone.stratos.feed.post/bebop";
    const JET_POST: &str = "at:space/did:web:stratos.example/zone.stratos.space.feed/bebop/did:plc:jetblack/zone.stratos.feed.post/see-you";
    const LEGACY_JET_POST: &str = "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop/did:plc:jetblack/zone.stratos.feed.post/see-you";
    const EIN_LIKE: &str = "at://did:plc:edward/app.bsky.feed.like/ein";
    const EIN_REPOST: &str = "at://did:plc:edward/app.bsky.feed.repost/ein";
    const SPACE_LIKE: &str = "at:space/did:web:stratos.example/zone.stratos.space.feed/bebop/did:plc:edward/app.bsky.feed.like/ein";
    const LEGACY_SPACE_LIKE: &str = "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop/did:plc:edward/app.bsky.feed.like/ein";
    const SOURCE: &str = "did:web:stratos.example#service";
    const THEN: &str = "1998-04-03T00:00:00.000Z";
    const LATER: &str = "1998-04-04T00:00:00.000Z";
    const SURVIVING_TABLES: [&str; 8] = [
        "actor_cursor",
        "actor_enrollment",
        "membership_baseline",
        "pds_boundary_generation",
        "pds_member_generation",
        "retention_metadata",
        "source_coverage",
        "projection_epoch",
    ];
    const PURGED_URI_COLUMNS: [(&str, &str); 8] = [
        ("post", "uri"),
        ("post_boundary", "uri"),
        ("interaction", "uri"),
        ("interaction", "subject_uri"),
        ("suppression_marker", "uri"),
        ("space_sync_stage", "uri"),
        ("space_cursor", "space_uri"),
        ("label_subject", "subject_key"),
    ];
    const SPACE_STATE_TABLES: [&str; 2] = ["space_repo_state", "space_repo_record"];

    fn key() -> StorageKey {
        StorageKey::from_bytes([9; 32])
    }

    fn bring_to_version_nine(connection: &mut Connection) {
        apply_migrations(connection, &MIGRATIONS[..LAST_VERSION_BEFORE_PURGE]).unwrap();
    }

    fn bring_to_version_ten(connection: &mut Connection) {
        apply_migrations(connection, &MIGRATIONS[..LAST_VERSION_BEFORE_DROP]).unwrap();
    }

    fn insert_post(connection: &Connection, uri: &str, author: &str, boundaries: &[&str]) {
        connection
            .execute(
                "INSERT INTO post (uri, author_did, cid, sort_at, indexed_at, retained_at, projection_bytes, record_json, blob_refs_json, row_version)
                 VALUES (?1, ?2, 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?3, ?3, ?4, 64, CAST('{\"text\":\"Bang\"}' AS BLOB), CAST('[]' AS BLOB), 2)",
                params![uri, author, THEN, LATER],
            )
            .unwrap();
        for boundary in boundaries {
            connection
                .execute(
                    "INSERT INTO post_boundary (uri, boundary, sort_at) VALUES (?1, ?2, ?3)",
                    params![uri, boundary, THEN],
                )
                .unwrap();
        }
    }

    fn insert_interaction(connection: &Connection, uri: &str, kind: &str, subject_uri: &str) {
        connection
            .execute(
                "INSERT INTO interaction (uri, actor_did, kind, subject_uri, boundary, indexed_at, retained_at, projection_bytes)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 48)",
                params![uri, EDWARD, kind, subject_uri, BOUNDARY, THEN, LATER],
            )
            .unwrap();
    }

    /// The rows an older build leaves behind: custody and space posts,
    /// interactions of every uri and subject combination, an unfinished stage,
    /// label state, and the tables the migration must not touch.
    fn populate_as_an_older_build(connection: &Connection) {
        insert_post(
            connection,
            SPIKE_POST,
            SPIKE,
            &[BOUNDARY, "did:web:stratos.example/swordfish"],
        );
        insert_post(connection, FAYE_POST, FAYE, &[BOUNDARY]);
        insert_post(connection, JET_POST, JET, &[BOUNDARY]);
        insert_post(connection, LEGACY_JET_POST, JET, &[BOUNDARY]);

        insert_interaction(connection, EIN_LIKE, "like", FAYE_POST);
        insert_interaction(connection, EIN_REPOST, "repost", SPIKE_POST);
        insert_interaction(
            connection,
            "at://did:plc:edward/app.bsky.feed.like/ein-two",
            "like",
            JET_POST,
        );
        insert_interaction(
            connection,
            "at://did:plc:edward/app.bsky.feed.like/ein-three",
            "like",
            LEGACY_JET_POST,
        );
        insert_interaction(connection, SPACE_LIKE, "like", FAYE_POST);
        insert_interaction(connection, LEGACY_SPACE_LIKE, "like", FAYE_POST);
        insert_interaction(
            connection,
            "at:space/did:web:stratos.example/zone.stratos.space.feed/bebop/did:plc:edward/app.bsky.feed.repost/ein",
            "repost",
            JET_POST,
        );

        for uri in [SPIKE_POST, JET_POST, LEGACY_JET_POST] {
            connection
                .execute(
                    "INSERT INTO suppression_marker (authority_did, source_id, uri, sequence) VALUES (?1, ?2, ?3, 7)",
                    params![AUTHORITY, SOURCE, uri],
                )
                .unwrap();
        }

        for space in [SPACE, LEGACY_SPACE] {
            connection
                .execute(
                    "INSERT INTO space_cursor (space_uri, did, boundary, cursor, updated_at) VALUES (?1, ?2, ?3, 'firehose:8', ?4)",
                    params![space, JET, BOUNDARY, THEN],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO space_sync_stage (space_uri, did, uri, boundary, deleted, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)",
                    params![space, JET, format!("{space}/{JET}/zone.stratos.feed.post/see-you"), BOUNDARY, THEN],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO space_sync_stage_cursor (space_uri, did, boundary, cursor, updated_at) VALUES (?1, ?2, ?3, 'unverified', ?4)",
                    params![space, FAYE, BOUNDARY, THEN],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO space_sync_pending_verification (space_uri, did, boundary, updated_at) VALUES (?1, ?2, ?3, ?4)",
                    params![space, JET, BOUNDARY, THEN],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO space_sync_stage_lifetime (space_uri, did, boundary, created_at, last_progress_at) VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![space, JET, BOUNDARY, THEN],
                )
                .unwrap();
        }

        for (subject_key, kind, author) in [
            (SPIKE, "account", SPIKE),
            (SPIKE_POST, "record", SPIKE),
            (JET_POST, "record", JET),
            (LEGACY_JET_POST, "record", JET),
        ] {
            connection
                .execute(
                    "INSERT INTO label_subject (authority_did, subject_key, subject_kind, author_did, label_sequence, state, attempts)
                     VALUES (?1, ?2, ?3, ?4, 12, 'takedown', 1)",
                    params![AUTHORITY, subject_key, kind, author],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO label_cursor (authority_did, sequence, updated_at) VALUES (?1, 412, ?2)",
                params![AUTHORITY, THEN],
            )
            .unwrap();

        connection
            .execute_batch(&format!(
                "INSERT INTO actor_cursor (authority_did, did, sequence, updated_at) VALUES ('{AUTHORITY}', '{SPIKE}', 9, '{THEN}');
                 INSERT INTO actor_enrollment (did, boundaries_json, observed_at, enrolled)
                   VALUES ('{SPIKE}', CAST('[\"bebop\"]' AS BLOB), '{THEN}', 1);
                 INSERT INTO membership_baseline (boundary, did, custody, repo_host, reconciled_at)
                   VALUES ('{BOUNDARY}', '{JET}', 'pds', 'https://pds.example.test/', '{THEN}'),
                          ('{BOUNDARY}', '{SPIKE}', 'stratos', NULL, '{THEN}');
                 INSERT INTO pds_boundary_generation (boundary, generation) VALUES ('{BOUNDARY}', 3);
                 INSERT INTO pds_member_generation (boundary, did, generation) VALUES ('{BOUNDARY}', '{JET}', 2);
                 INSERT INTO retention_metadata (key, value) VALUES ('retention_epoch', 5);
                 INSERT INTO source_coverage (authority_did, source_id, boundary, start_sequence, end_sequence, verified_at)
                   VALUES ('{AUTHORITY}', '{SOURCE}', '{BOUNDARY}', 1, 9, '{THEN}');
                 INSERT INTO projection_epoch (scope, epoch, updated_at) VALUES ('global', 4, '{THEN}');"
            ))
            .unwrap();
    }

    fn old_build_memory_database() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", true)
            .unwrap();
        bring_to_version_nine(&mut connection);
        populate_as_an_older_build(&connection);
        connection
    }

    type Rows = Vec<Vec<Value>>;

    fn table_rows(connection: &Connection, query: &str) -> Rows {
        let mut statement = connection.prepare(query).unwrap();
        let columns = statement.column_count();
        statement
            .query_map([], |row| {
                (0..columns)
                    .map(|index| row.get::<_, Value>(index))
                    .collect()
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    fn ordered_columns(connection: &Connection, table: &str) -> String {
        let columns = connection
            .prepare(&format!("SELECT * FROM {table}"))
            .unwrap()
            .column_count();
        (1..=columns)
            .map(|index| index.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    }

    fn every_table(connection: &Connection) -> Vec<String> {
        table_rows(
            connection,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .into_iter()
        .map(|row| match &row[0] {
            Value::Text(name) => name.clone(),
            other => panic!("table name is not text: {other:?}"),
        })
        .collect()
    }

    fn whole_database(connection: &Connection) -> BTreeMap<String, Rows> {
        every_table(connection)
            .into_iter()
            .map(|table| {
                let order = ordered_columns(connection, &table);
                let rows = table_rows(
                    connection,
                    &format!("SELECT * FROM {table} ORDER BY {order}"),
                );
                (table, rows)
            })
            .collect()
    }

    /// Everything the migration must leave byte for byte: the tables it does
    /// not touch, and the custody rows of the tables it purges.
    fn survivors(connection: &Connection) -> BTreeMap<String, Rows> {
        let mut kept: BTreeMap<String, Rows> = SURVIVING_TABLES
            .iter()
            .map(|table| {
                let order = ordered_columns(connection, table);
                (
                    (*table).to_owned(),
                    table_rows(
                        connection,
                        &format!("SELECT * FROM {table} ORDER BY {order}"),
                    ),
                )
            })
            .collect();
        let custody_posts = format!("('{SPIKE_POST}', '{FAYE_POST}')");
        let custody_likes = format!("('{EIN_LIKE}', '{EIN_REPOST}')");
        for (name, query) in [
            (
                "post",
                format!("SELECT * FROM post WHERE uri IN {custody_posts} ORDER BY uri"),
            ),
            (
                "post_boundary",
                format!(
                    "SELECT * FROM post_boundary WHERE uri IN {custody_posts} ORDER BY uri, boundary"
                ),
            ),
            (
                "interaction",
                format!("SELECT * FROM interaction WHERE uri IN {custody_likes} ORDER BY uri"),
            ),
            (
                "suppression_marker",
                format!("SELECT * FROM suppression_marker WHERE uri = '{SPIKE_POST}'"),
            ),
            (
                "label_subject",
                format!(
                    "SELECT * FROM label_subject WHERE subject_key IN ('{SPIKE}', '{SPIKE_POST}') ORDER BY subject_key"
                ),
            ),
        ] {
            kept.insert(name.to_owned(), table_rows(connection, &query));
        }
        kept
    }

    fn count(connection: &Connection, table: &str) -> i64 {
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn version_of(connection: &Connection) -> u32 {
        connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap()
    }

    fn assert_purged_and_kept(connection: &Connection, survivors_before: &BTreeMap<String, Rows>) {
        assert_eq!(version_of(connection), 10);
        assert_eq!(count(connection, "schema_migration"), 10);
        assert_eq!(&survivors(connection), survivors_before);
        for (table, expected) in [
            ("post", 2),
            ("post_boundary", 3),
            ("interaction", 2),
            ("suppression_marker", 1),
            ("space_sync_stage", 0),
            ("space_sync_stage_cursor", 0),
            ("space_sync_pending_verification", 0),
            ("space_sync_stage_lifetime", 0),
            ("space_cursor", 0),
            ("label_subject", 2),
            ("label_cursor", 0),
            ("space_repo_state", 0),
            ("space_repo_record", 0),
        ] {
            assert_eq!(count(connection, table), expected, "{table}");
        }
        for (table, column) in PURGED_URI_COLUMNS {
            let remaining: i64 = connection
                .query_row(
                    &format!(
                        "SELECT COUNT(*) FROM {table} WHERE {column} LIKE 'at:space/%' OR {column} LIKE '%/space/%'"
                    ),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(remaining, 0, "{table}.{column} still names a space");
        }
        let account_labels = count(connection, "label_subject WHERE subject_kind = 'account'");
        assert_eq!(account_labels, 1);
    }

    #[test]
    fn purges_every_space_row_and_keeps_everything_else_byte_for_byte() {
        let mut connection = old_build_memory_database();
        let survivors_before = survivors(&connection);
        assert_eq!(count(&connection, "post"), 4);
        assert_eq!(count(&connection, "interaction"), 7);

        bring_to_version_ten(&mut connection);

        assert_purged_and_kept(&connection, &survivors_before);
    }

    #[test]
    fn purges_the_same_rows_when_foreign_keys_are_not_enforced() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        bring_to_version_nine(&mut connection);
        populate_as_an_older_build(&connection);
        let survivors_before = survivors(&connection);

        bring_to_version_ten(&mut connection);

        assert_purged_and_kept(&connection, &survivors_before);
        let orphans: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM post_boundary WHERE uri NOT IN (SELECT uri FROM post)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(orphans, 0);
    }

    #[test]
    fn the_two_space_state_tables_exist_and_are_empty() {
        let mut connection = old_build_memory_database();
        bring_to_version_ten(&mut connection);

        let table_sql = |name: &str| -> String {
            connection
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [name],
                    |row| row.get(0),
                )
                .unwrap()
        };
        let state_sql = table_sql("space_repo_state");
        assert!(state_sql.contains("PRIMARY KEY (space_uri, did)"));
        assert!(state_sql.contains("length(set_hash) = 2048"));
        let record_sql = table_sql("space_repo_record");
        assert!(record_sql.contains("PRIMARY KEY (space_uri, did, collection, rkey)"));
        assert!(record_sql.contains("WITHOUT ROWID"));
        for table in SPACE_STATE_TABLES {
            assert_eq!(count(&connection, table), 0);
            let indexed_columns: Vec<String> = table_rows(
                &connection,
                &format!(
                    "SELECT name FROM pragma_index_info('{table}_boundary_idx') ORDER BY seqno"
                ),
            )
            .into_iter()
            .map(|row| match &row[0] {
                Value::Text(name) => name.clone(),
                other => panic!("column name is not text: {other:?}"),
            })
            .collect();
            assert_eq!(indexed_columns, ["boundary", "did"], "{table}");
        }
        let wrong_length = connection.execute(
            "INSERT INTO space_repo_state (space_uri, did, boundary, host, generation, rev, set_hash, record_count, updated_at)
             VALUES (?1, ?2, ?3, 'https://pds.example.test', 0, '3jzfcijpj2z2a', zeroblob(2047), 0, ?4)",
            params![SPACE, JET, BOUNDARY, THEN],
        );
        assert!(
            wrong_length.is_err(),
            "a state that is not 2048 bytes is refused"
        );
        connection
            .execute(
                "INSERT INTO space_repo_state (space_uri, did, boundary, host, generation, rev, set_hash, record_count, updated_at)
                 VALUES (?1, ?2, ?3, 'https://pds.example.test', 0, '3jzfcijpj2z2a', zeroblob(2048), 0, ?4)",
                params![SPACE, JET, BOUNDARY, THEN],
            )
            .unwrap();
    }

    #[test]
    fn a_second_apply_changes_nothing() {
        let mut connection = old_build_memory_database();
        bring_to_version_ten(&mut connection);
        let after_first = whole_database(&connection);

        bring_to_version_ten(&mut connection);

        assert_eq!(whole_database(&connection), after_first);
        assert_eq!(version_of(&connection), 10);
    }

    #[test]
    fn an_empty_database_reaches_version_ten() {
        let mut connection = Connection::open_in_memory().unwrap();

        bring_to_version_ten(&mut connection);

        assert_eq!(version_of(&connection), 10);
        assert_eq!(count(&connection, "schema_migration"), 10);
        for table in SPACE_STATE_TABLES {
            assert_eq!(count(&connection, table), 0);
        }
    }

    #[test]
    fn the_purge_is_all_or_nothing() {
        let mut connection = old_build_memory_database();
        let before = whole_database(&connection);
        let purge = &MIGRATIONS[LAST_VERSION_BEFORE_PURGE];
        assert_eq!(purge.version, 10);

        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        let failure = transaction.execute_batch(&format!("{} INVALID SQL;", purge.sql));
        assert!(failure.is_err());
        let mid_flight: i64 = transaction
            .query_row("SELECT COUNT(*) FROM post", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mid_flight, 2, "the purge ran before the failure");
        transaction.rollback().unwrap();

        assert_eq!(whole_database(&connection), before);
        assert_eq!(version_of(&connection), 9);
        assert_eq!(count(&connection, "schema_migration"), 9);
    }

    const PURGED_TABLES: [&str; 11] = [
        "interaction",
        "post_boundary",
        "post",
        "suppression_marker",
        "space_sync_stage",
        "space_sync_stage_cursor",
        "space_sync_pending_verification",
        "space_sync_stage_lifetime",
        "space_cursor",
        "label_subject",
        "label_cursor",
    ];

    #[test]
    fn a_purge_that_fails_after_its_deletes_leaves_version_nine_and_every_row() {
        let mut connection = old_build_memory_database();
        let before = whole_database(&connection);
        for table in PURGED_TABLES {
            assert!(!before[table].is_empty(), "{table} holds rows to purge");
        }
        let purge = &MIGRATIONS[LAST_VERSION_BEFORE_PURGE];
        assert_eq!(purge.version, 10);
        // A duplicate version fails only when it runs, after every delete of the
        // purge has run in the same batch.
        let failing_purge = format!(
            "{} INSERT INTO schema_migration (version, applied_at) VALUES (1, 0);",
            purge.sql
        );
        let migrations: Vec<Migration> = MIGRATIONS[..LAST_VERSION_BEFORE_PURGE]
            .iter()
            .map(|migration| Migration {
                version: migration.version,
                sql: migration.sql,
            })
            .chain(std::iter::once(Migration {
                version: purge.version,
                sql: failing_purge.leak(),
            }))
            .collect();

        let outcome = apply_migrations(&mut connection, &migrations);

        assert!(outcome.is_err(), "{outcome:?}");
        assert_eq!(version_of(&connection), 9);
        let after = whole_database(&connection);
        assert_eq!(after["schema_migration"], before["schema_migration"]);
        for table in PURGED_TABLES {
            assert_eq!(after[table], before[table], "{table}");
        }
        assert_eq!(after, before);
    }

    #[test]
    fn a_database_at_version_thirteen_is_refused_and_left_alone() {
        let mut connection = old_build_memory_database();
        apply(&mut connection).unwrap();
        connection.pragma_update(None, "user_version", 13).unwrap();
        let before = whole_database(&connection);

        assert!(apply(&mut connection).is_err());

        assert_eq!(whole_database(&connection), before);
    }

    fn database_path(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "stratos-feedgen-ng-migration-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        path
    }

    /// An encrypted file at version 9 with an older build's rows, made the way
    /// the store opens a database: key first, foreign keys on.
    fn old_build_encrypted_file(name: &str) -> PathBuf {
        let path = database_path(name);
        let mut connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_READ_WRITE,
        )
        .unwrap();
        connection
            .execute_batch(&format!(
                "PRAGMA key = \"x'{}'\"; PRAGMA foreign_keys = ON;",
                key().as_hex()
            ))
            .unwrap();
        bring_to_version_nine(&mut connection);
        populate_as_an_older_build(&connection);
        drop(connection);
        path
    }

    fn survivors_of_file(path: &PathBuf) -> BTreeMap<String, Rows> {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(&format!("PRAGMA key = \"x'{}'\";", key().as_hex()))
            .unwrap();
        assert_eq!(version_of(&connection), 9);
        survivors(&connection)
    }

    #[test]
    fn an_encrypted_file_migrates_once_and_stays_migrated_across_reopens() {
        let path = old_build_encrypted_file("purge");
        let survivors_before = survivors_of_file(&path);

        let mut migrated = open_raw_encrypted_file(&path);
        bring_to_version_ten(&mut migrated);
        assert_purged_and_kept(&migrated, &survivors_before);
        let foreign_keys: i64 = migrated
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert_eq!(
            foreign_keys, 1,
            "the migration connection enforces foreign keys"
        );
        let after_first_open = whole_database(&migrated);
        drop(migrated);

        let mut reopened = open_raw_encrypted_file(&path);
        bring_to_version_ten(&mut reopened);
        assert_purged_and_kept(&reopened, &survivors_before);
        assert_eq!(whole_database(&reopened), after_first_open);
        drop(reopened);
        fs::remove_file(path).unwrap();
    }

    /// An encrypted file opened the way the store opens one, but not migrated.
    fn open_raw_encrypted_file(path: &PathBuf) -> Connection {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(&format!(
                "PRAGMA key = \"x'{}'\"; PRAGMA foreign_keys = ON;",
                key().as_hex()
            ))
            .unwrap();
        connection
    }

    // Migration 11: databases at version 10, which still hold the stage tables.

    const STAGE_TABLES: [&str; 5] = [
        "space_cursor",
        "space_sync_stage",
        "space_sync_stage_cursor",
        "space_sync_pending_verification",
        "space_sync_stage_lifetime",
    ];
    const STAGE_TRIGGERS: [&str; 3] = [
        "stage_lifetime_after_stage_delete",
        "stage_lifetime_after_cursor_delete",
        "stage_lifetime_after_pending_delete",
    ];

    fn put_rows_in_the_stage_tables(connection: &Connection) {
        connection
            .execute_batch(&format!(
                "INSERT INTO space_cursor (space_uri, did, boundary, cursor, updated_at)
                   VALUES ('{SPACE}', '{JET}', '{BOUNDARY}', 'firehose:8', '{THEN}');
                 INSERT INTO space_sync_stage (space_uri, did, uri, boundary, deleted, updated_at)
                   VALUES ('{SPACE}', '{JET}', '{JET_POST}', '{BOUNDARY}', 1, '{THEN}');
                 INSERT INTO space_sync_stage_cursor (space_uri, did, boundary, cursor, updated_at)
                   VALUES ('{SPACE}', '{FAYE}', '{BOUNDARY}', 'unverified', '{THEN}');
                 INSERT INTO space_sync_pending_verification (space_uri, did, boundary, updated_at)
                   VALUES ('{SPACE}', '{JET}', '{BOUNDARY}', '{THEN}');
                 INSERT INTO space_sync_stage_lifetime (space_uri, did, boundary, created_at, last_progress_at)
                   VALUES ('{SPACE}', '{JET}', '{BOUNDARY}', '{THEN}', '{THEN}');"
            ))
            .unwrap();
    }

    fn schema_names(connection: &Connection, kind: &str) -> Vec<String> {
        table_rows(
            connection,
            &format!("SELECT name FROM sqlite_master WHERE type = '{kind}' ORDER BY name"),
        )
        .into_iter()
        .map(|row| match &row[0] {
            Value::Text(name) => name.clone(),
            other => panic!("name is not text: {other:?}"),
        })
        .collect()
    }

    fn version_ten_database_with_stage_rows() -> Connection {
        let mut connection = old_build_memory_database();
        bring_to_version_ten(&mut connection);
        put_rows_in_the_stage_tables(&connection);
        for table in STAGE_TABLES {
            assert_eq!(count(&connection, table), 1, "{table}");
        }
        let triggers = schema_names(&connection, "trigger");
        for trigger in STAGE_TRIGGERS {
            assert!(triggers.contains(&trigger.to_owned()), "{trigger}");
        }
        connection
    }

    #[test]
    fn a_version_ten_database_with_rows_in_the_five_tables_reaches_eleven_and_loses_only_them() {
        let mut connection = version_ten_database_with_stage_rows();
        let mut before = whole_database(&connection);
        let triggers_before = schema_names(&connection, "trigger");
        let indexes_before = schema_names(&connection, "index");

        apply_migrations(
            &mut connection,
            &MIGRATIONS[..LAST_VERSION_BEFORE_LABEL_SCOPE],
        )
        .unwrap();

        assert_eq!(version_of(&connection), 11);
        let mut after = whole_database(&connection);
        for table in STAGE_TABLES {
            assert!(before.remove(table).is_some(), "{table} was there");
            assert!(!after.contains_key(table), "{table} is gone");
        }
        let triggers_after = schema_names(&connection, "trigger");
        assert_eq!(
            triggers_before
                .iter()
                .filter(|name| !STAGE_TRIGGERS.contains(&name.as_str()))
                .collect::<Vec<_>>(),
            triggers_after.iter().collect::<Vec<_>>(),
            "only the three stage triggers went"
        );
        assert!(
            triggers_after.contains(&"interaction_after_post_delete".to_owned()),
            "the post-delete trigger stays"
        );
        let indexes_after = schema_names(&connection, "index");
        assert!(
            indexes_after
                .iter()
                .all(|name| !name.starts_with("space_sync_") && !name.starts_with("space_cursor_")),
            "{indexes_after:?}"
        );
        assert!(indexes_before.len() > indexes_after.len());
        let migrations_before = before.remove("schema_migration").unwrap();
        let migrations_after = after.remove("schema_migration").unwrap();
        assert_eq!(migrations_after.len(), 11);
        assert_eq!(&migrations_after[..10], migrations_before.as_slice());
        assert_eq!(after, before, "every other table is byte for byte the same");
        for table in SPACE_STATE_TABLES {
            assert!(after.contains_key(table), "{table} stays");
        }
    }

    #[test]
    fn a_second_apply_after_the_drop_changes_nothing() {
        let mut connection = version_ten_database_with_stage_rows();
        let through_the_drop = &MIGRATIONS[..LAST_VERSION_BEFORE_LABEL_SCOPE];
        apply_migrations(&mut connection, through_the_drop).unwrap();
        let after_first = whole_database(&connection);
        let schema_first = schema_names(&connection, "table");

        apply_migrations(&mut connection, through_the_drop).unwrap();

        assert_eq!(whole_database(&connection), after_first);
        assert_eq!(schema_names(&connection, "table"), schema_first);
        assert_eq!(version_of(&connection), 11);
    }

    #[test]
    fn an_empty_database_reaches_version_eleven_without_the_stage_tables() {
        let mut connection = Connection::open_in_memory().unwrap();

        apply_migrations(
            &mut connection,
            &MIGRATIONS[..LAST_VERSION_BEFORE_LABEL_SCOPE],
        )
        .unwrap();

        assert_eq!(version_of(&connection), 11);
        assert_eq!(count(&connection, "schema_migration"), 11);
        let tables = every_table(&connection);
        for table in STAGE_TABLES {
            assert!(!tables.contains(&table.to_owned()), "{table}");
        }
        for table in SPACE_STATE_TABLES {
            assert_eq!(count(&connection, table), 0);
        }
        let triggers = schema_names(&connection, "trigger");
        assert_eq!(triggers, ["interaction_after_post_delete"]);
    }

    #[test]
    fn a_failure_after_the_drops_rolls_back_to_version_ten_through_apply_migrations() {
        let mut connection = version_ten_database_with_stage_rows();
        let before = whole_database(&connection);
        let schema_before = table_rows(
            &connection,
            "SELECT type, name FROM sqlite_master ORDER BY type, name",
        );
        let drop_batch = &MIGRATIONS[LAST_VERSION_BEFORE_DROP];
        assert_eq!(drop_batch.version, 11);
        // A duplicate version fails only when it runs, after every drop of the
        // batch has run in the same transaction.
        let failing_drop = format!(
            "{} INSERT INTO schema_migration (version, applied_at) VALUES (1, 0);",
            drop_batch.sql
        );
        let migrations: Vec<Migration> = MIGRATIONS[..LAST_VERSION_BEFORE_DROP]
            .iter()
            .map(|migration| Migration {
                version: migration.version,
                sql: migration.sql,
            })
            .chain(std::iter::once(Migration {
                version: drop_batch.version,
                sql: failing_drop.leak(),
            }))
            .collect();

        let outcome = apply_migrations(&mut connection, &migrations);

        assert!(outcome.is_err(), "{outcome:?}");
        assert_eq!(version_of(&connection), 10);
        assert_eq!(whole_database(&connection), before);
        assert_eq!(
            table_rows(
                &connection,
                "SELECT type, name FROM sqlite_master ORDER BY type, name",
            ),
            schema_before,
            "the tables, indexes and triggers are all still there"
        );
    }

    #[tokio::test]
    async fn a_verified_sync_of_a_member_works_end_to_end_on_a_migrated_file_store() {
        use std::sync::{Arc, Mutex};

        use async_trait::async_trait;
        use serde_json::json;

        use crate::{
            credential_issuer::{
                CredentialExpiry, CredentialMintError, IssuedSpaceCredential, SpaceCredentialIssuer,
            },
            credential_manager::SpaceCredentialManager,
            lifecycle::ControlLifecycle,
            membership_reconciler::PdsPollTarget,
            pds_space_sync::{
                PdsSpaceSynchronizer, VerifiedSyncOutcome,
                test_host::{HostRepo, StaticKemKeys, TestClock, TestHost, TestSource},
            },
            readiness::FeedReadinessGate,
            service::ProjectionReader,
            space_http_signature::SpaceHttpSignatureKey,
        };

        struct Issuer;

        #[async_trait]
        impl SpaceCredentialIssuer for Issuer {
            async fn mint(
                &self,
                _: &str,
                _: &SpaceHttpSignatureKey,
                _: u64,
            ) -> Result<IssuedSpaceCredential, CredentialMintError> {
                Ok(IssuedSpaceCredential {
                    credential: "header.payload.signature".to_owned(),
                    expires_at: CredentialExpiry::from_epoch_seconds(10_000),
                })
            }
        }

        fn credential_clock() -> u64 {
            1_000
        }

        const PDS: &str = "https://pds.example.test/";
        const POST: &str = "zone.stratos.feed.post";
        const RETAINED: &str = "2100-01-01T00:00:00.000Z";
        const AS_OF: &str = "1998-04-03T12:00:00.000Z";
        let post = |text: &str| json!({ "$type": POST, "text": text, "createdAt": THEN });

        let path = old_build_encrypted_file("verified-sync");
        let survivors_before = survivors_of_file(&path);
        let mut store = EncryptedStore::open(&path, key()).unwrap();
        assert_eq!(version_of(&store.connection), 12);
        assert_eq!(
            survivors(&store.connection),
            survivors_before,
            "every row meant to survive both migrations is byte for byte what it was"
        );
        let tables = every_table(&store.connection);
        for table in STAGE_TABLES {
            assert!(!tables.contains(&table.to_owned()), "{table}");
        }
        let foreign_keys: i64 = store
            .connection
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert_eq!(
            foreign_keys, 1,
            "the store's connection enforces foreign keys"
        );
        store
            .replace_pds_space_members(
                BOUNDARY,
                vec![PdsSpaceMember {
                    did: JET.to_owned(),
                }],
                THEN,
            )
            .unwrap();
        let lifecycle = ControlLifecycle::for_authority(
            ProjectionReader::new(store),
            Arc::new(Mutex::new(FeedReadinessGate::default())),
            AUTHORITY,
        )
        .unwrap();
        let host = TestHost::serving(SPACE);
        let mut repo = HostRepo::new(1);
        repo.put(2, POST, "see-you", post("See you space cowboy"));
        host.hold(JET, repo);
        let source = TestSource::new(StaticKemKeys::new());
        source.host_at(PDS, Arc::clone(&host));
        let synchronizer = PdsSpaceSynchronizer::with_clock(
            source,
            Arc::new(SpaceCredentialManager::with_clock(
                Arc::new(Issuer),
                credential_clock,
            )),
            TestClock::new(),
        );
        let target = PdsPollTarget {
            space_uri: SPACE.to_owned(),
            boundary: BOUNDARY.to_owned(),
            did: JET.to_owned(),
            host: PDS.to_owned(),
            generation: lifecycle
                .pds_member_generation(BOUNDARY, JET)
                .unwrap()
                .expect("jet is a current member"),
        };

        assert_eq!(
            synchronizer
                .sync_target(&lifecycle, &target, RETAINED)
                .await,
            VerifiedSyncOutcome::Replaced
        );
        host.edit(JET, |repo| {
            repo.put(3, POST, "bebop", post("Bang"));
        });
        assert_eq!(
            synchronizer
                .sync_target(&lifecycle, &target, RETAINED)
                .await,
            VerifiedSyncOutcome::Promoted
        );
        assert_eq!(
            synchronizer
                .sync_target(&lifecycle, &target, RETAINED)
                .await,
            VerifiedSyncOutcome::Unchanged
        );

        let served: Vec<String> = lifecycle
            .read(|projection| projection.served_posts(BOUNDARY, AS_OF))
            .into_iter()
            .map(|(uri, _)| uri)
            .collect();
        for rkey in ["see-you", "bebop"] {
            let uri = format!("{SPACE}/{JET}/{POST}/{rkey}");
            assert!(served.contains(&uri), "{uri} is served: {served:?}");
        }
        assert!(
            served.contains(&FAYE_POST.to_owned()),
            "the kept custody post is still served"
        );
        assert!(
            !served.contains(&LEGACY_JET_POST.to_owned()),
            "the purged post is not"
        );
        drop(lifecycle);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn the_label_cursor_reads_zero_after_the_migration() {
        let path = old_build_encrypted_file("labels");
        let store = EncryptedStore::open(&path, key()).unwrap();

        assert_eq!(store.label_cursor(AUTHORITY).unwrap(), 0);
        assert_eq!(count(&store.connection, "label_cursor"), 0);
        drop(store);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn foreign_keys_cascade_and_post_deletes_remove_interactions_on_the_migration_connection() {
        let store = EncryptedStore::open_memory(key()).unwrap();
        let connection = &store.connection;
        let enforced: i64 = connection
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert_eq!(enforced, 1);
        insert_post(connection, FAYE_POST, FAYE, &[BOUNDARY]);
        insert_interaction(connection, EIN_LIKE, "like", FAYE_POST);

        connection
            .execute("DELETE FROM post WHERE uri = ?1", [FAYE_POST])
            .unwrap();

        assert_eq!(
            count(connection, "post_boundary"),
            0,
            "ON DELETE CASCADE is active"
        );
        assert_eq!(
            count(connection, "interaction"),
            0,
            "the post-delete trigger fires"
        );
    }

    // Migration 12: databases at version 11, with a label cursor and label
    // subjects in both states an older build knew.

    fn version_eleven_database_with_a_label_cursor() -> Connection {
        let mut connection = old_build_memory_database();
        apply_migrations(
            &mut connection,
            &MIGRATIONS[..LAST_VERSION_BEFORE_LABEL_SCOPE],
        )
        .unwrap();
        connection
            .execute(
                "INSERT INTO label_cursor (authority_did, sequence, updated_at) VALUES (?1, 412, ?2)",
                params![AUTHORITY, THEN],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE label_subject SET state = 'reinstating', attempts = 2 WHERE subject_key = ?1",
                [SPIKE],
            )
            .unwrap();
        assert_eq!(version_of(&connection), 11);
        connection
    }

    fn label_subject_rows(connection: &Connection) -> Rows {
        table_rows(
            connection,
            "SELECT authority_did, subject_key, subject_kind, author_did, label_sequence, state, attempts
             FROM label_subject ORDER BY authority_did, subject_key",
        )
    }

    #[test]
    fn a_version_eleven_database_keeps_its_labels_and_reads_its_scope_as_unknown() {
        let mut connection = version_eleven_database_with_a_label_cursor();
        let mut before = whole_database(&connection);
        let subjects_before = label_subject_rows(&connection);
        assert!(subjects_before.len() >= 2, "{subjects_before:?}");

        apply(&mut connection).unwrap();

        assert_eq!(version_of(&connection), 12);
        assert_eq!(label_subject_rows(&connection), subjects_before);
        assert_eq!(
            table_rows(
                &connection,
                "SELECT authority_did, sequence, updated_at, scope_json FROM label_cursor",
            ),
            [vec![
                Value::Text(AUTHORITY.to_owned()),
                Value::Integer(412),
                Value::Text(THEN.to_owned()),
                Value::Null,
            ]]
        );
        let mut after = whole_database(&connection);
        for table in ["label_cursor", "label_subject", "schema_migration"] {
            before.remove(table);
            after.remove(table);
        }
        assert_eq!(after, before, "every other table is byte for byte the same");
        assert!(
            schema_names(&connection, "index").contains(&"label_subject_author_idx".to_owned())
        );
    }

    #[test]
    fn only_version_twelve_admits_a_lifted_subject() {
        let mut connection = version_eleven_database_with_a_label_cursor();
        let insert_lifted = |connection: &Connection| {
            connection.execute(
                "INSERT INTO label_subject (authority_did, subject_key, subject_kind, author_did, label_sequence, state, attempts)
                 VALUES (?1, ?2, 'record', ?3, 9, 'lifted', 0)",
                params![AUTHORITY, JET_POST, JET],
            )
        };
        assert!(insert_lifted(&connection).is_err());

        apply(&mut connection).unwrap();

        insert_lifted(&connection).unwrap();
    }

    #[test]
    fn a_second_apply_after_the_label_scope_migration_changes_nothing() {
        let mut connection = version_eleven_database_with_a_label_cursor();
        apply(&mut connection).unwrap();
        let after_first = whole_database(&connection);

        apply(&mut connection).unwrap();

        assert_eq!(whole_database(&connection), after_first);
        assert_eq!(version_of(&connection), 12);
    }

    #[test]
    fn a_binary_that_knows_eleven_migrations_refuses_a_version_twelve_database_and_leaves_it_alone()
    {
        let mut connection = version_eleven_database_with_a_label_cursor();
        apply(&mut connection).unwrap();
        let before = whole_database(&connection);

        let older_binary = apply_migrations(
            &mut connection,
            &MIGRATIONS[..LAST_VERSION_BEFORE_LABEL_SCOPE],
        );

        assert!(older_binary.is_err());
        assert_eq!(whole_database(&connection), before);
        assert_eq!(version_of(&connection), 12);
    }

    #[test]
    fn a_failure_in_the_label_scope_migration_leaves_version_eleven_and_every_row() {
        let mut connection = version_eleven_database_with_a_label_cursor();
        let before = whole_database(&connection);
        let scope_batch = &MIGRATIONS[LAST_VERSION_BEFORE_LABEL_SCOPE];
        assert_eq!(scope_batch.version, 12);
        // A duplicate version fails only when it runs, after the rebuild of the
        // batch has run in the same transaction.
        let failing_batch = format!(
            "{} INSERT INTO schema_migration (version, applied_at) VALUES (1, 0);",
            scope_batch.sql
        );
        let migrations: Vec<Migration> = MIGRATIONS[..LAST_VERSION_BEFORE_LABEL_SCOPE]
            .iter()
            .map(|migration| Migration {
                version: migration.version,
                sql: migration.sql,
            })
            .chain(std::iter::once(Migration {
                version: scope_batch.version,
                sql: failing_batch.leak(),
            }))
            .collect();

        let outcome = apply_migrations(&mut connection, &migrations);

        assert!(outcome.is_err(), "{outcome:?}");
        assert_eq!(version_of(&connection), 11);
        assert_eq!(whole_database(&connection), before);
    }
}
