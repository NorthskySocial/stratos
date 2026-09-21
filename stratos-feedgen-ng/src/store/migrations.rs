use rusqlite::{Connection, TransactionBehavior};

struct Migration {
    version: u32,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[Migration {
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
}];

pub(super) fn apply(connection: &mut Connection) -> rusqlite::Result<()> {
    let latest_version = MIGRATIONS.last().map_or(0, |migration| migration.version);
    for migration in MIGRATIONS {
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

    use super::{Migration, apply};

    #[test]
    fn initializes_the_versioned_projection_schema() {
        let mut connection = Connection::open_in_memory().unwrap();
        apply(&mut connection).unwrap();

        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 1);
        let migration_count: u32 = connection
            .query_row("SELECT COUNT(*) FROM schema_migration", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(migration_count, 1);
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
    fn rejects_a_database_from_a_newer_store_format() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection.pragma_update(None, "user_version", 2).unwrap();

        assert!(apply(&mut connection).is_err());
    }
}
