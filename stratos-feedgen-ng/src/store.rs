use std::{
    ffi::CString,
    fmt,
    fs::File,
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{ffi::OsStrExt, fs::MetadataExt, fs::PermissionsExt},
    },
    path::{Component, Path},
};

use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};

mod migrations;

const STORAGE_KEY_BYTES: usize = 32;
const MAX_ENCODED_KEY_BYTES: usize = STORAGE_KEY_BYTES * 2 + 1;
const SQLITE_CACHE_KIB: u32 = 16 * 1024;
const MAX_PURGE_BATCH: u16 = 512;
const MAX_SPACE_PROMOTION_BATCH: u16 = 512;

pub struct StorageKey([u8; STORAGE_KEY_BYTES]);

impl StorageKey {
    pub fn from_bytes(value: [u8; STORAGE_KEY_BYTES]) -> Self {
        Self(value)
    }

    pub fn from_secret_file(path: &Path) -> Result<Self, StoreError> {
        let mut file = open_secret_file(path)?;
        validate_secret_file(&file)?;

        let mut encoded = Vec::with_capacity(MAX_ENCODED_KEY_BYTES);
        file.by_ref()
            .take((MAX_ENCODED_KEY_BYTES + 1) as u64)
            .read_to_end(&mut encoded)
            .map_err(|_| StoreError::KeyFileAccess)?;
        let key = if encoded.len() > MAX_ENCODED_KEY_BYTES {
            Err(StoreError::InvalidKeyFile)
        } else {
            parse_hex_key(&encoded)
        };
        encoded.fill(0);
        key.map(Self)
    }

    fn as_hex(&self) -> String {
        self.0.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

impl fmt::Debug for StorageKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("StorageKey([REDACTED])")
    }
}

pub enum StoreError {
    Open(rusqlite::Error),
    CipherUnavailable,
    KeyFileAccess,
    InsecureKeyFile,
    InvalidKeyFile,
    InvalidProjectionMutation,
    StaleCursor,
    UnverifiedSpaceStage,
}

impl fmt::Debug for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Open(_) => "Open",
            Self::CipherUnavailable => "CipherUnavailable",
            Self::KeyFileAccess => "KeyFileAccess",
            Self::InsecureKeyFile => "InsecureKeyFile",
            Self::InvalidKeyFile => "InvalidKeyFile",
            Self::InvalidProjectionMutation => "InvalidProjectionMutation",
            Self::StaleCursor => "StaleCursor",
            Self::UnverifiedSpaceStage => "UnverifiedSpaceStage",
        };
        formatter.write_str(name)
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Open(_) => formatter.write_str("encrypted store could not be opened"),
            Self::CipherUnavailable => formatter.write_str("SQLCipher is unavailable"),
            Self::KeyFileAccess => {
                formatter.write_str("storage key file could not be read securely")
            }
            Self::InsecureKeyFile => formatter.write_str("storage key file permissions are unsafe"),
            Self::InvalidKeyFile => formatter.write_str("storage key file is invalid"),
            Self::InvalidProjectionMutation => {
                formatter.write_str("projection mutation is invalid")
            }
            Self::StaleCursor => formatter.write_str("projection cursor is stale"),
            Self::UnverifiedSpaceStage => {
                formatter.write_str("space stage has not completed verification")
            }
        }
    }
}

impl std::error::Error for StoreError {}

fn open_secret_file(path: &Path) -> Result<File, StoreError> {
    if !path.is_absolute() {
        return Err(StoreError::InsecureKeyFile);
    }
    let components = path
        .components()
        .filter_map(|component| match component {
            Component::RootDir => None,
            Component::Normal(component) => Some(Ok(component)),
            Component::CurDir | Component::ParentDir | Component::Prefix(_) => {
                Some(Err(StoreError::InsecureKeyFile))
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let Some((file_name, directories)) = components.split_last() else {
        return Err(StoreError::InsecureKeyFile);
    };

    let mut directory = open_directory(libc::AT_FDCWD, b"/")?;
    for component in directories {
        directory = open_directory(directory.as_raw_fd(), component.as_bytes())?;
    }
    let file = open_file(directory.as_raw_fd(), file_name.as_bytes())?;
    Ok(File::from(file))
}

fn open_directory(parent: libc::c_int, name: &[u8]) -> Result<OwnedFd, StoreError> {
    open_descriptor(
        parent,
        name,
        libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW,
    )
}

fn open_file(parent: libc::c_int, name: &[u8]) -> Result<OwnedFd, StoreError> {
    open_descriptor(
        parent,
        name,
        libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
    )
}

fn open_descriptor(
    parent: libc::c_int,
    name: &[u8],
    flags: libc::c_int,
) -> Result<OwnedFd, StoreError> {
    let name = CString::new(name).map_err(|_| StoreError::InsecureKeyFile)?;
    let descriptor = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    if descriptor < 0 {
        return Err(StoreError::KeyFileAccess);
    }
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

fn validate_secret_file(file: &File) -> Result<(), StoreError> {
    let metadata = file.metadata().map_err(|_| StoreError::KeyFileAccess)?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(StoreError::InsecureKeyFile);
    }
    Ok(())
}

fn parse_hex_key(encoded: &[u8]) -> Result<[u8; STORAGE_KEY_BYTES], StoreError> {
    let encoded = encoded.strip_suffix(b"\n").unwrap_or(encoded);
    if encoded.len() != STORAGE_KEY_BYTES * 2 {
        return Err(StoreError::InvalidKeyFile);
    }

    let mut key = [0; STORAGE_KEY_BYTES];
    for (index, byte) in key.iter_mut().enumerate() {
        let high = hex_nibble(encoded[index * 2]).ok_or(StoreError::InvalidKeyFile)?;
        let low = hex_nibble(encoded[index * 2 + 1]).ok_or(StoreError::InvalidKeyFile)?;
        *byte = high << 4 | low;
    }
    Ok(key)
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

pub struct EncryptedStore {
    connection: Connection,
}

pub struct ProjectionPost {
    pub uri: String,
    pub author_did: String,
    pub cid: String,
    pub sort_at: String,
    pub indexed_at: String,
    pub retained_at: String,
    pub record_json: Vec<u8>,
    pub blob_refs_json: Vec<u8>,
    pub boundaries: Vec<String>,
}

pub struct ActorPage {
    pub authority_did: String,
    pub actor_did: String,
    pub sequence: u64,
    pub upserts: Vec<ProjectionPost>,
    pub deletes: Vec<String>,
    pub updated_at: String,
}

pub struct SpaceStagePage {
    pub space_uri: String,
    pub actor_did: String,
    pub boundary: String,
    pub next_cursor: Option<String>,
    pub updated_at: String,
}

struct SpaceStageRow {
    uri: String,
    boundary: String,
    deleted: bool,
    cid: Option<String>,
    sort_at: Option<String>,
    indexed_at: Option<String>,
    record_json: Option<Vec<u8>>,
    blob_refs_json: Option<Vec<u8>>,
    updated_at: String,
}

pub enum SpaceStageMutation {
    Upsert {
        uri: String,
        cid: String,
        sort_at: String,
        indexed_at: String,
        record_json: Vec<u8>,
        blob_refs_json: Vec<u8>,
    },
    Delete {
        uri: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeedPost {
    pub uri: String,
    pub author_did: String,
    pub cid: String,
    pub sort_at: String,
    pub indexed_at: String,
    pub record_json: Vec<u8>,
    pub boundaries: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeedPage {
    pub posts: Vec<FeedPost>,
    pub cursor: Option<crate::cursor::FeedCursor>,
}

impl EncryptedStore {
    pub fn open(path: &Path, key: StorageKey) -> Result<Self, StoreError> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_READ_WRITE,
        )
        .map_err(StoreError::Open)?;
        Self::configure(connection, key)
    }

    pub fn open_memory(key: StorageKey) -> Result<Self, StoreError> {
        let connection = Connection::open_in_memory().map_err(StoreError::Open)?;
        Self::configure(connection, key)
    }

    pub fn cipher_version(&self) -> Result<String, StoreError> {
        self.connection
            .query_row("PRAGMA cipher_version", [], |row| row.get(0))
            .map_err(StoreError::Open)
    }

    pub fn apply_actor_page(&mut self, page: ActorPage) -> Result<(), StoreError> {
        validate_actor_page(&page)?;
        let page = normalize_actor_page(page);
        let sequence =
            i64::try_from(page.sequence).map_err(|_| StoreError::InvalidProjectionMutation)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        let current_sequence: Option<i64> = transaction
            .query_row(
                "SELECT sequence FROM actor_cursor WHERE authority_did = ?1 AND did = ?2",
                params![page.authority_did, page.actor_did],
                |row| row.get(0),
            )
            .optional()
            .map_err(StoreError::Open)?;
        if current_sequence.is_some_and(|current| current > sequence) {
            return Err(StoreError::StaleCursor);
        }
        for post in &page.upserts {
            transaction
                .execute(
                    "INSERT INTO post (uri, author_did, cid, sort_at, indexed_at, retained_at, projection_bytes, record_json, blob_refs_json, row_version)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)
                     ON CONFLICT(uri) DO UPDATE SET author_did = excluded.author_did, cid = excluded.cid,
                       sort_at = excluded.sort_at, indexed_at = excluded.indexed_at, retained_at = excluded.retained_at,
                       projection_bytes = excluded.projection_bytes, record_json = excluded.record_json,
                       blob_refs_json = excluded.blob_refs_json, row_version = post.row_version + 1",
                    params![
                        post.uri,
                        post.author_did,
                        post.cid,
                        post.sort_at,
                        post.indexed_at,
                        post.retained_at,
                        projection_bytes(post),
                        post.record_json,
                        post.blob_refs_json,
                    ],
                )
                .map_err(StoreError::Open)?;
            transaction
                .execute("DELETE FROM post_boundary WHERE uri = ?1", [&post.uri])
                .map_err(StoreError::Open)?;
            for boundary in &post.boundaries {
                transaction
                    .execute(
                        "INSERT INTO post_boundary (uri, boundary, sort_at) VALUES (?1, ?2, ?3)",
                        params![post.uri, boundary, post.sort_at],
                    )
                    .map_err(StoreError::Open)?;
            }
        }
        for uri in &page.deletes {
            transaction
                .execute("DELETE FROM post WHERE uri = ?1", [uri])
                .map_err(StoreError::Open)?;
        }
        transaction
            .execute(
                "INSERT INTO actor_cursor (authority_did, did, sequence, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(authority_did, did) DO UPDATE SET sequence = excluded.sequence, updated_at = excluded.updated_at",
                params![page.authority_did, page.actor_did, sequence, page.updated_at],
            )
            .map_err(StoreError::Open)?;
        transaction.commit().map_err(StoreError::Open)
    }

    pub fn list_boundaries_for_uris(&self, uris: &[String]) -> Result<Vec<String>, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT boundary FROM post_boundary WHERE uri = ?1 ORDER BY boundary ASC")
            .map_err(StoreError::Open)?;
        let mut boundaries = Vec::new();
        for uri in uris {
            let rows = statement
                .query_map([uri], |row| row.get(0))
                .map_err(StoreError::Open)?;
            boundaries.extend(
                rows.collect::<Result<Vec<String>, _>>()
                    .map_err(StoreError::Open)?,
            );
        }
        Ok(boundaries)
    }

    pub fn mark_space_stage_terminal(&mut self, page: SpaceStagePage) -> Result<(), StoreError> {
        self.stage_space_page(page, Vec::new())
    }

    pub fn stage_space_page(
        &mut self,
        page: SpaceStagePage,
        mutations: Vec<SpaceStageMutation>,
    ) -> Result<(), StoreError> {
        validate_space_stage_page(&page)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        for mutation in mutations {
            stage_space_mutation(&transaction, &page, mutation)?;
        }
        update_space_stage_checkpoint(&transaction, &page)?;
        transaction.commit().map_err(StoreError::Open)
    }

    pub fn promote_verified_space_stage(
        &mut self,
        space_uri: &str,
        actor_did: &str,
        retained_at: &str,
    ) -> Result<(), StoreError> {
        validate_space_stage_scope(space_uri, actor_did)?;
        if !is_utc_timestamp(retained_at) {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        let pending: Option<i64> = transaction
            .query_row(
                "SELECT 1 FROM space_sync_pending_verification WHERE space_uri = ?1 AND did = ?2",
                params![space_uri, actor_did],
                |row| row.get(0),
            )
            .optional()
            .map_err(StoreError::Open)?;
        if pending.is_none() {
            return Err(StoreError::UnverifiedSpaceStage);
        }
        let mut after_uri = None;
        loop {
            let stages =
                load_space_stage_rows(&transaction, space_uri, actor_did, after_uri.as_deref())?;
            let Some(last_uri) = stages.last().map(|stage| stage.uri.clone()) else {
                break;
            };
            for stage in stages {
                apply_verified_space_stage_row(
                    &transaction,
                    space_uri,
                    actor_did,
                    retained_at,
                    stage,
                )?;
            }
            after_uri = Some(last_uri);
        }
        transaction
            .execute(
                "DELETE FROM space_sync_stage WHERE space_uri = ?1 AND did = ?2",
                params![space_uri, actor_did],
            )
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "DELETE FROM space_sync_pending_verification WHERE space_uri = ?1 AND did = ?2",
                params![space_uri, actor_did],
            )
            .map_err(StoreError::Open)?;
        transaction.commit().map_err(StoreError::Open)
    }

    pub fn list_posts_by_boundary(
        &self,
        boundary: &str,
        cursor: Option<&crate::cursor::FeedCursor>,
        limit: u16,
        as_of: &str,
    ) -> Result<FeedPage, StoreError> {
        if !is_utc_timestamp(as_of) {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let limit = i64::from(limit.clamp(1, crate::cursor::MAX_FEED_LIMIT));
        let posts = match cursor {
            Some(cursor) => self.list_posts_after_cursor(boundary, cursor, limit, as_of)?,
            None => self.list_initial_posts(boundary, limit, as_of)?,
        };
        let cursor = if posts.len() == limit as usize {
            posts.last().map(|post| crate::cursor::FeedCursor {
                sort_at: post.sort_at.clone(),
                uri: post.uri.clone(),
            })
        } else {
            None
        };
        Ok(FeedPage { posts, cursor })
    }

    pub fn purge_expired(&mut self, as_of: &str, limit: u16) -> Result<u64, StoreError> {
        if !is_utc_timestamp(as_of) {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        let deleted = transaction.execute("DELETE FROM post WHERE uri IN (SELECT uri FROM post WHERE retained_at <= ?1 ORDER BY retained_at ASC, uri ASC LIMIT ?2)", params![as_of, i64::from(limit.clamp(1, MAX_PURGE_BATCH))]).map_err(StoreError::Open)?;
        transaction.commit().map_err(StoreError::Open)?;
        Ok(deleted as u64)
    }

    pub fn purge_boundary(&mut self, boundary: &str) -> Result<u64, StoreError> {
        if boundary.is_empty() {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "DELETE FROM space_cursor WHERE boundary = ?1 OR boundary = ''",
                [boundary],
            )
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "DELETE FROM space_sync_pending_verification WHERE boundary = ?1 OR boundary = ''",
                [boundary],
            )
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "DELETE FROM space_sync_stage WHERE boundary = ?1",
                [boundary],
            )
            .map_err(StoreError::Open)?;
        transaction
            .execute("DELETE FROM post_boundary WHERE boundary = ?1", [boundary])
            .map_err(StoreError::Open)?;
        let deleted = transaction
            .execute("DELETE FROM post WHERE NOT EXISTS (SELECT 1 FROM post_boundary WHERE post_boundary.uri = post.uri)", [])
            .map_err(StoreError::Open)?;
        transaction.commit().map_err(StoreError::Open)?;
        Ok(deleted as u64)
    }

    fn list_initial_posts(
        &self,
        boundary: &str,
        limit: i64,
        as_of: &str,
    ) -> Result<Vec<FeedPost>, StoreError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT p.uri, p.author_did, p.cid, p.sort_at, p.indexed_at, p.record_json,
              COALESCE((SELECT json_group_array(boundary) FROM post_boundary WHERE uri = p.uri), '[]')
             FROM post_boundary b JOIN post p ON p.uri = b.uri
             WHERE b.boundary = ?1 AND p.retained_at > ?2 ORDER BY b.sort_at DESC, b.uri ASC LIMIT ?3",
            )
            .map_err(StoreError::Open)?;
        statement
            .query_map(params![boundary, as_of, limit], feed_post_from_row)
            .map_err(StoreError::Open)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::Open)
    }

    fn list_posts_after_cursor(
        &self,
        boundary: &str,
        cursor: &crate::cursor::FeedCursor,
        limit: i64,
        as_of: &str,
    ) -> Result<Vec<FeedPost>, StoreError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT p.uri, p.author_did, p.cid, p.sort_at, p.indexed_at, p.record_json,
              COALESCE((SELECT json_group_array(boundary) FROM post_boundary WHERE uri = p.uri), '[]')
             FROM post_boundary b JOIN post p ON p.uri = b.uri
             WHERE b.boundary = ?1 AND p.retained_at > ?2 AND (b.sort_at < ?3 OR (b.sort_at = ?3 AND b.uri > ?4))
             ORDER BY b.sort_at DESC, b.uri ASC LIMIT ?5",
            )
            .map_err(StoreError::Open)?;
        statement
            .query_map(
                params![boundary, as_of, cursor.sort_at, cursor.uri, limit],
                feed_post_from_row,
            )
            .map_err(StoreError::Open)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::Open)
    }

    fn configure(mut connection: Connection, key: StorageKey) -> Result<Self, StoreError> {
        connection
            .execute_batch(&format!(
                "PRAGMA key = \"x'{}'\"; PRAGMA cipher_memory_security = ON; \
                 PRAGMA temp_store = MEMORY; PRAGMA cache_size = -{SQLITE_CACHE_KIB}; \
                 PRAGMA mmap_size = 0; PRAGMA foreign_keys = ON;",
                key.as_hex()
            ))
            .map_err(StoreError::Open)?;
        let cipher_version: String = connection
            .query_row("PRAGMA cipher_version", [], |row| row.get(0))
            .map_err(StoreError::Open)?;
        if cipher_version.is_empty() {
            return Err(StoreError::CipherUnavailable);
        }
        migrations::apply(&mut connection).map_err(StoreError::Open)?;
        Ok(Self { connection })
    }
}

fn is_space_uri(value: &str) -> bool {
    let segments: Vec<_> = value
        .strip_prefix("at://")
        .unwrap_or_default()
        .split('/')
        .collect();
    matches!(segments.as_slice(), [authority, "space", space_type, space_key]
        if crate::identifier::RecordUri::parse(&format!("at://{authority}/space/{space_type}/{space_key}/did:plc:spikespiegel/zone.stratos.feed.post/x")).is_ok())
}

fn validate_space_stage_page(page: &SpaceStagePage) -> Result<(), StoreError> {
    crate::identifier::Did::parse(page.actor_did.clone())
        .map_err(|_| StoreError::InvalidProjectionMutation)?;
    if !is_space_uri(&page.space_uri)
        || page.boundary.is_empty()
        || page.next_cursor.as_deref().is_some_and(str::is_empty)
        || !is_utc_timestamp(&page.updated_at)
    {
        return Err(StoreError::InvalidProjectionMutation);
    }
    Ok(())
}

fn stage_space_mutation(
    transaction: &rusqlite::Transaction<'_>,
    page: &SpaceStagePage,
    mutation: SpaceStageMutation,
) -> Result<(), StoreError> {
    match mutation {
        SpaceStageMutation::Upsert {
            uri,
            cid,
            sort_at,
            indexed_at,
            record_json,
            blob_refs_json,
        } => {
            validate_space_stage_uri(page, &uri)?;
            if cid.is_empty() || !is_utc_timestamp(&sort_at) || !is_utc_timestamp(&indexed_at) {
                return Err(StoreError::InvalidProjectionMutation);
            }
            transaction
                .execute(
                    "INSERT INTO space_sync_stage (space_uri, did, uri, boundary, deleted, cid, sort_at, indexed_at, record_json, blob_refs_json, updated_at)
                     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8, ?9, ?10)
                     ON CONFLICT(space_uri, did, uri) DO UPDATE SET boundary = excluded.boundary,
                       deleted = excluded.deleted, cid = excluded.cid, sort_at = excluded.sort_at,
                       indexed_at = excluded.indexed_at, record_json = excluded.record_json,
                       blob_refs_json = excluded.blob_refs_json, updated_at = excluded.updated_at",
                    params![
                        page.space_uri,
                        page.actor_did,
                        uri,
                        page.boundary,
                        cid,
                        sort_at,
                        indexed_at,
                        record_json,
                        blob_refs_json,
                        page.updated_at,
                    ],
                )
                .map_err(StoreError::Open)?;
        }
        SpaceStageMutation::Delete { uri } => {
            validate_space_stage_uri(page, &uri)?;
            transaction
                .execute(
                    "INSERT INTO space_sync_stage (space_uri, did, uri, boundary, deleted, cid, sort_at, indexed_at, record_json, blob_refs_json, updated_at)
                     VALUES (?1, ?2, ?3, ?4, 1, NULL, NULL, NULL, NULL, NULL, ?5)
                     ON CONFLICT(space_uri, did, uri) DO UPDATE SET boundary = excluded.boundary,
                       deleted = excluded.deleted, cid = NULL, sort_at = NULL, indexed_at = NULL,
                       record_json = NULL, blob_refs_json = NULL, updated_at = excluded.updated_at",
                    params![
                        page.space_uri,
                        page.actor_did,
                        uri,
                        page.boundary,
                        page.updated_at,
                    ],
                )
                .map_err(StoreError::Open)?;
        }
    }
    Ok(())
}

fn validate_space_stage_uri(page: &SpaceStagePage, value: &str) -> Result<(), StoreError> {
    let uri = crate::identifier::RecordUri::parse(value)
        .map_err(|_| StoreError::InvalidProjectionMutation)?;
    if !matches!(uri, crate::identifier::RecordUri::Space { .. })
        || uri.author().as_str() != page.actor_did
        || !value.starts_with(&format!("{}/", page.space_uri))
    {
        return Err(StoreError::InvalidProjectionMutation);
    }
    Ok(())
}

fn update_space_stage_checkpoint(
    transaction: &rusqlite::Transaction<'_>,
    page: &SpaceStagePage,
) -> Result<(), StoreError> {
    if let Some(cursor) = &page.next_cursor {
        transaction
            .execute(
                "INSERT INTO space_cursor (space_uri, did, boundary, cursor, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(space_uri, did) DO UPDATE SET boundary = excluded.boundary,
                   cursor = excluded.cursor, updated_at = excluded.updated_at",
                params![page.space_uri, page.actor_did, page.boundary, cursor, page.updated_at],
            )
            .map_err(StoreError::Open)?;
    } else {
        transaction
            .execute(
                "INSERT INTO space_sync_pending_verification (space_uri, did, boundary, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(space_uri, did) DO UPDATE SET boundary = excluded.boundary,
                   updated_at = excluded.updated_at",
                params![page.space_uri, page.actor_did, page.boundary, page.updated_at],
            )
            .map_err(StoreError::Open)?;
    }
    Ok(())
}

fn validate_space_stage_scope(space_uri: &str, actor_did: &str) -> Result<(), StoreError> {
    crate::identifier::Did::parse(actor_did.to_string())
        .map_err(|_| StoreError::InvalidProjectionMutation)?;
    if !is_space_uri(space_uri) {
        return Err(StoreError::InvalidProjectionMutation);
    }
    Ok(())
}

fn load_space_stage_rows(
    transaction: &rusqlite::Transaction<'_>,
    space_uri: &str,
    actor_did: &str,
    after_uri: Option<&str>,
) -> Result<Vec<SpaceStageRow>, StoreError> {
    let mut statement = transaction
        .prepare(
            "SELECT uri, boundary, deleted, cid, sort_at, indexed_at, record_json, blob_refs_json, updated_at
             FROM space_sync_stage WHERE space_uri = ?1 AND did = ?2 AND (?3 IS NULL OR uri > ?3)
             ORDER BY uri ASC LIMIT ?4",
        )
        .map_err(StoreError::Open)?;
    statement
        .query_map(
            params![
                space_uri,
                actor_did,
                after_uri,
                i64::from(MAX_SPACE_PROMOTION_BATCH),
            ],
            |row| {
                Ok(SpaceStageRow {
                    uri: row.get(0)?,
                    boundary: row.get(1)?,
                    deleted: row.get::<_, i64>(2)? != 0,
                    cid: row.get(3)?,
                    sort_at: row.get(4)?,
                    indexed_at: row.get(5)?,
                    record_json: row.get(6)?,
                    blob_refs_json: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        )
        .map_err(StoreError::Open)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StoreError::Open)
}

fn apply_verified_space_stage_row(
    transaction: &rusqlite::Transaction<'_>,
    space_uri: &str,
    actor_did: &str,
    retained_at: &str,
    stage: SpaceStageRow,
) -> Result<(), StoreError> {
    let page = SpaceStagePage {
        space_uri: space_uri.to_string(),
        actor_did: actor_did.to_string(),
        boundary: stage.boundary.clone(),
        next_cursor: None,
        updated_at: stage.updated_at.clone(),
    };
    validate_space_stage_page(&page)?;
    validate_space_stage_uri(&page, &stage.uri)?;
    if stage.deleted {
        if stage.cid.is_some()
            || stage.sort_at.is_some()
            || stage.indexed_at.is_some()
            || stage.record_json.is_some()
            || stage.blob_refs_json.is_some()
        {
            return Err(StoreError::InvalidProjectionMutation);
        }
        transaction
            .execute("DELETE FROM post WHERE uri = ?1", [&stage.uri])
            .map_err(StoreError::Open)?;
        return Ok(());
    }
    let Some(cid) = stage.cid else {
        return Err(StoreError::InvalidProjectionMutation);
    };
    let Some(sort_at) = stage.sort_at else {
        return Err(StoreError::InvalidProjectionMutation);
    };
    let Some(indexed_at) = stage.indexed_at else {
        return Err(StoreError::InvalidProjectionMutation);
    };
    let Some(record_json) = stage.record_json else {
        return Err(StoreError::InvalidProjectionMutation);
    };
    let Some(blob_refs_json) = stage.blob_refs_json else {
        return Err(StoreError::InvalidProjectionMutation);
    };
    if cid.is_empty() || !is_utc_timestamp(&sort_at) || !is_utc_timestamp(&indexed_at) {
        return Err(StoreError::InvalidProjectionMutation);
    }
    let projection_bytes = projection_bytes_from_fields(
        &stage.uri,
        actor_did,
        &cid,
        &sort_at,
        &indexed_at,
        &record_json,
        &blob_refs_json,
    );
    transaction
        .execute(
            "INSERT INTO post (uri, author_did, cid, sort_at, indexed_at, retained_at, projection_bytes, record_json, blob_refs_json, row_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)
             ON CONFLICT(uri) DO UPDATE SET author_did = excluded.author_did, cid = excluded.cid,
               sort_at = excluded.sort_at, indexed_at = excluded.indexed_at, retained_at = excluded.retained_at,
               projection_bytes = excluded.projection_bytes, record_json = excluded.record_json,
               blob_refs_json = excluded.blob_refs_json, row_version = post.row_version + 1",
            params![
                stage.uri,
                actor_did,
                cid,
                sort_at,
                indexed_at,
                retained_at,
                projection_bytes,
                record_json,
                blob_refs_json,
            ],
        )
        .map_err(StoreError::Open)?;
    transaction
        .execute("DELETE FROM post_boundary WHERE uri = ?1", [&stage.uri])
        .map_err(StoreError::Open)?;
    transaction
        .execute(
            "INSERT INTO post_boundary (uri, boundary, sort_at) VALUES (?1, ?2, ?3)",
            params![stage.uri, stage.boundary, sort_at],
        )
        .map_err(StoreError::Open)?;
    Ok(())
}

fn feed_post_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FeedPost> {
    Ok(FeedPost {
        uri: row.get(0)?,
        author_did: row.get(1)?,
        cid: row.get(2)?,
        sort_at: row.get(3)?,
        indexed_at: row.get(4)?,
        record_json: row.get(5)?,
        boundaries: serde_json::from_str(&row.get::<_, String>(6)?)
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
    })
}

fn projection_bytes(post: &ProjectionPost) -> i64 {
    projection_bytes_from_fields(
        &post.uri,
        &post.author_did,
        &post.cid,
        &post.sort_at,
        &post.indexed_at,
        &post.record_json,
        &post.blob_refs_json,
    )
}

fn projection_bytes_from_fields(
    uri: &str,
    author_did: &str,
    cid: &str,
    sort_at: &str,
    indexed_at: &str,
    record_json: &[u8],
    blob_refs_json: &[u8],
) -> i64 {
    (uri.len()
        + author_did.len()
        + cid.len()
        + sort_at.len()
        + indexed_at.len()
        + record_json.len()
        + blob_refs_json.len()) as i64
}

fn is_utc_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    let shaped = bytes.len() == 24
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z'
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) || byte.is_ascii_digit()
        });
    if !shaped {
        return false;
    }
    let year = decimal(&bytes[0..4]);
    let month = decimal(&bytes[5..7]);
    let day = decimal(&bytes[8..10]);
    (1..=12).contains(&month)
        && day >= 1
        && day <= days_in_month(year, month)
        && decimal(&bytes[11..13]) < 24
        && decimal(&bytes[14..16]) < 60
        && decimal(&bytes[17..19]) < 60
}

fn decimal(value: &[u8]) -> u16 {
    value
        .iter()
        .fold(0, |number, byte| number * 10 + u16::from(byte - b'0'))
}

fn days_in_month(year: u16, month: u16) -> u16 {
    match month {
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn validate_actor_page(page: &ActorPage) -> Result<(), StoreError> {
    crate::identifier::Did::parse(page.authority_did.clone())
        .map_err(|_| StoreError::InvalidProjectionMutation)?;
    crate::identifier::Did::parse(page.actor_did.clone())
        .map_err(|_| StoreError::InvalidProjectionMutation)?;
    for post in &page.upserts {
        let uri = crate::identifier::RecordUri::parse(&post.uri)
            .map_err(|_| StoreError::InvalidProjectionMutation)?;
        if uri.author().as_str() != post.author_did
            || !record_belongs_to_page(&uri, page)
            || !is_utc_timestamp(&post.sort_at)
            || !is_utc_timestamp(&post.indexed_at)
            || !is_utc_timestamp(&post.retained_at)
            || post.boundaries.iter().any(|boundary| boundary.is_empty())
        {
            return Err(StoreError::InvalidProjectionMutation);
        }
    }
    for uri in &page.deletes {
        let uri = crate::identifier::RecordUri::parse(uri)
            .map_err(|_| StoreError::InvalidProjectionMutation)?;
        if !record_belongs_to_page(&uri, page) {
            return Err(StoreError::InvalidProjectionMutation);
        }
    }
    Ok(())
}

fn normalize_actor_page(mut page: ActorPage) -> ActorPage {
    let denied_uris = page
        .upserts
        .iter()
        .filter(|post| post.boundaries.is_empty())
        .map(|post| post.uri.clone())
        .collect::<Vec<_>>();
    page.upserts.retain(|post| !post.boundaries.is_empty());
    page.deletes.extend(denied_uris);
    page.deletes.sort_unstable();
    page.deletes.dedup();
    page
}

fn record_belongs_to_page(uri: &crate::identifier::RecordUri, page: &ActorPage) -> bool {
    matches!(uri, crate::identifier::RecordUri::Repo { .. })
        && uri.author().as_str() == page.actor_did
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
        path::PathBuf,
    };

    use rusqlite::Connection;

    use super::{
        ActorPage, EncryptedStore, ProjectionPost, SpaceStageMutation, SpaceStagePage, StorageKey,
        StoreError,
    };

    fn key(byte: u8) -> StorageKey {
        StorageKey::from_bytes([byte; 32])
    }

    fn spike_post() -> ProjectionPost {
        ProjectionPost {
            uri: "at://did:plc:spikespiegel/zone.stratos.feed.post/see-you".to_string(),
            author_did: "did:plc:spikespiegel".to_string(),
            cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            sort_at: "1998-04-03T00:00:00.000Z".to_string(),
            indexed_at: "1998-04-03T00:00:01.000Z".to_string(),
            retained_at: "1998-04-04T00:00:00.000Z".to_string(),
            record_json: br#"{"text":"Bang"}"#.to_vec(),
            blob_refs_json: b"[]".to_vec(),
            boundaries: vec!["bebop".to_string()],
        }
    }

    fn space_post() -> ProjectionPost {
        let mut post = spike_post();
        post.uri = "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop/did:plc:spikespiegel/zone.stratos.feed.post/see-you".to_string();
        post
    }

    fn actor_page(sequence: u64, upserts: Vec<ProjectionPost>, deletes: Vec<String>) -> ActorPage {
        ActorPage {
            authority_did: "did:web:stratos.example".to_string(),
            actor_did: "did:plc:spikespiegel".to_string(),
            sequence,
            upserts,
            deletes,
            updated_at: "1998-04-03T00:00:02.000Z".to_string(),
        }
    }

    fn space_stage_page(next_cursor: Option<&str>) -> SpaceStagePage {
        SpaceStagePage {
            space_uri: "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop"
                .to_string(),
            actor_did: "did:plc:spikespiegel".to_string(),
            boundary: "bebop".to_string(),
            next_cursor: next_cursor.map(str::to_string),
            updated_at: "1998-04-03T00:00:00.000Z".to_string(),
        }
    }

    fn staged_space_post() -> SpaceStageMutation {
        SpaceStageMutation::Upsert {
            uri: "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop/did:plc:spikespiegel/zone.stratos.feed.post/see-you".to_string(),
            cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            sort_at: "1998-04-03T00:00:00.000Z".to_string(),
            indexed_at: "1998-04-03T00:00:01.000Z".to_string(),
            record_json: br#"{\"text\":\"Bang\"}"#.to_vec(),
            blob_refs_json: b"[]".to_vec(),
        }
    }

    fn temporary_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("stratos-feedgen-ng-{name}-{}", std::process::id()))
    }

    fn write_secret_file(name: &str, contents: &[u8], mode: u32) -> PathBuf {
        let path = temporary_path(name);
        let _ = fs::remove_file(&path);
        fs::write(&path, contents).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    #[test]
    fn opens_only_when_sqlcipher_is_available() {
        let store = EncryptedStore::open_memory(key(7)).unwrap();
        assert!(!store.cipher_version().unwrap().is_empty());
    }

    #[test]
    fn reopens_with_the_same_key_and_rejects_a_wrong_key() {
        let path = temporary_path("cipher-reopen.sqlite");
        let _ = fs::remove_file(&path);
        {
            let store = EncryptedStore::open(&path, key(7)).unwrap();
            assert!(!store.cipher_version().unwrap().is_empty());
            store
                .connection
                .execute(
                    "INSERT INTO retention_metadata (key, value) VALUES ('probe', 1)",
                    [],
                )
                .unwrap();
        }
        let bytes = fs::read(&path).unwrap();
        assert_ne!(&bytes[..16], b"SQLite format 3\0");
        let reopened = EncryptedStore::open(&path, key(7)).unwrap();
        assert_eq!(
            reopened
                .connection
                .query_row(
                    "SELECT value FROM retention_metadata WHERE key = 'probe'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        assert!(EncryptedStore::open(&path, key(8)).is_err());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_a_plain_sqlite_file() {
        let path = temporary_path("plain.sqlite");
        let _ = fs::remove_file(&path);
        let plain = Connection::open(&path).unwrap();
        plain
            .execute("CREATE TABLE plain_state (id INTEGER PRIMARY KEY)", [])
            .unwrap();
        drop(plain);

        assert!(EncryptedStore::open(&path, key(7)).is_err());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn redacts_storage_keys_in_debug_output() {
        assert_eq!(format!("{:?}", key(7)), "StorageKey([REDACTED])");
    }

    #[test]
    fn redacts_underlying_storage_errors_in_debug_output() {
        let secret = "0707070707070707070707070707070707070707070707070707070707070707";
        let error =
            super::StoreError::Open(rusqlite::Error::InvalidParameterName(secret.to_string()));
        assert!(!format!("{error:?}").contains(secret));
    }

    #[test]
    fn applies_posts_and_actor_cursor_in_one_transaction() {
        let mut store = EncryptedStore::open_memory(key(7)).unwrap();
        store
            .apply_actor_page(actor_page(8, vec![spike_post()], Vec::new()))
            .unwrap();

        assert_eq!(
            store
                .connection
                .query_row("SELECT sequence FROM actor_cursor", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            8
        );
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM post WHERE uri = ?1",
                    ["at://did:plc:spikespiegel/zone.stratos.feed.post/see-you"],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT sort_at FROM post_boundary WHERE boundary = 'bebop'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "1998-04-03T00:00:00.000Z"
        );
    }

    #[test]
    fn rejects_a_stale_page_without_deleting_its_existing_projection() {
        let mut store = EncryptedStore::open_memory(key(7)).unwrap();
        let post = spike_post();
        store
            .apply_actor_page(actor_page(8, vec![post], Vec::new()))
            .unwrap();

        assert!(matches!(
            store.apply_actor_page(actor_page(
                7,
                Vec::new(),
                vec!["at://did:plc:spikespiegel/zone.stratos.feed.post/see-you".to_string()],
            )),
            Err(StoreError::StaleCursor)
        ));
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM post", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn rejects_posts_that_do_not_belong_to_the_cursor_actor() {
        let mut store = EncryptedStore::open_memory(key(7)).unwrap();
        let mut page = actor_page(8, vec![spike_post()], Vec::new());
        page.actor_did = "did:plc:fayevalentine".to_string();

        assert!(matches!(
            store.apply_actor_page(page),
            Err(StoreError::InvalidProjectionMutation)
        ));
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM post", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn removes_a_post_when_authority_withdraws_all_boundaries() {
        let mut store = EncryptedStore::open_memory(key(7)).unwrap();
        store
            .apply_actor_page(actor_page(8, vec![spike_post()], Vec::new()))
            .unwrap();
        let mut withdrawn = spike_post();
        withdrawn.boundaries.clear();

        store
            .apply_actor_page(actor_page(9, vec![withdrawn], Vec::new()))
            .unwrap();

        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM post", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT sequence FROM actor_cursor", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            9
        );
    }

    #[test]
    fn rejects_deletes_that_do_not_belong_to_the_cursor_actor() {
        let mut store = EncryptedStore::open_memory(key(7)).unwrap();
        let post = spike_post();
        store
            .apply_actor_page(actor_page(8, vec![post], Vec::new()))
            .unwrap();
        let mut page = actor_page(
            9,
            Vec::new(),
            vec!["at://did:plc:spikespiegel/zone.stratos.feed.post/see-you".to_string()],
        );
        page.actor_did = "did:plc:fayevalentine".to_string();

        assert!(matches!(
            store.apply_actor_page(page),
            Err(StoreError::InvalidProjectionMutation)
        ));
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM post", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn rejects_space_posts_from_the_actor_projection_path() {
        let mut store = EncryptedStore::open_memory(key(7)).unwrap();

        assert!(matches!(
            store.apply_actor_page(actor_page(8, vec![space_post()], Vec::new())),
            Err(StoreError::InvalidProjectionMutation)
        ));
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM post", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn lists_boundary_posts_with_the_typescript_cursor_order() {
        let mut store = EncryptedStore::open_memory(key(7)).unwrap();
        let first = spike_post();
        let mut second = spike_post();
        second.uri = "at://did:plc:spikespiegel/zone.stratos.feed.post/zebra".to_string();
        store
            .apply_actor_page(actor_page(8, vec![second, first], Vec::new()))
            .unwrap();

        let first_page = store
            .list_posts_by_boundary("bebop", None, 1, "1998-04-03T12:00:00.000Z")
            .unwrap();
        assert_eq!(first_page.posts.len(), 1);
        assert_eq!(
            first_page.posts[0].uri,
            "at://did:plc:spikespiegel/zone.stratos.feed.post/see-you"
        );
        let second_page = store
            .list_posts_by_boundary(
                "bebop",
                first_page.cursor.as_ref(),
                1,
                "1998-04-03T12:00:00.000Z",
            )
            .unwrap();
        assert_eq!(
            second_page.posts[0].uri,
            "at://did:plc:spikespiegel/zone.stratos.feed.post/zebra"
        );
        assert!(second_page.cursor.is_some());
        let empty_page = store
            .list_posts_by_boundary(
                "bebop",
                second_page.cursor.as_ref(),
                1,
                "1998-04-03T12:00:00.000Z",
            )
            .unwrap();
        assert!(empty_page.posts.is_empty());
    }

    #[test]
    fn never_lists_expired_posts_and_purges_them_with_boundaries() {
        let mut store = EncryptedStore::open_memory(key(7)).unwrap();
        let mut expired = spike_post();
        expired.retained_at = "1998-04-03T00:00:00.000Z".to_string();
        store
            .apply_actor_page(actor_page(8, vec![expired], Vec::new()))
            .unwrap();

        let page = store
            .list_posts_by_boundary("bebop", None, 50, "1998-04-03T12:00:00.000Z")
            .unwrap();
        assert!(page.posts.is_empty());
        assert_eq!(
            store.purge_expired("1998-04-03T12:00:00.000Z", 1).unwrap(),
            1
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM post_boundary", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn boundary_purge_preserves_posts_still_scoped_to_another_boundary() {
        let mut store = EncryptedStore::open_memory(key(7)).unwrap();
        let mut post = spike_post();
        post.boundaries.push("red-tail".to_string());
        store
            .apply_actor_page(actor_page(8, vec![post], Vec::new()))
            .unwrap();

        assert_eq!(store.purge_boundary("bebop").unwrap(), 0);
        assert!(
            store
                .list_posts_by_boundary("bebop", None, 50, "1998-04-03T12:00:00.000Z")
                .unwrap()
                .posts
                .is_empty()
        );
        assert_eq!(
            store
                .list_posts_by_boundary("red-tail", None, 50, "1998-04-03T12:00:00.000Z")
                .unwrap()
                .posts
                .len(),
            1
        );
    }

    #[test]
    fn boundary_purge_removes_staged_space_state_before_it_can_promote() {
        let mut store = EncryptedStore::open_memory(key(7)).unwrap();
        store
            .stage_space_page(space_stage_page(Some("firehose:8")), Vec::new())
            .unwrap();
        store
            .stage_space_page(space_stage_page(None), Vec::new())
            .unwrap();

        assert_eq!(store.purge_boundary("bebop").unwrap(), 0);
        assert!(matches!(
            store.promote_verified_space_stage(
                "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop",
                "did:plc:spikespiegel",
                "1998-04-04T00:00:00.000Z",
            ),
            Err(StoreError::UnverifiedSpaceStage)
        ));
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM space_sync_stage", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM space_cursor", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn terminal_space_stage_stays_invisible_until_promotion() {
        let mut store = EncryptedStore::open_memory(key(7)).unwrap();
        store
            .stage_space_page(space_stage_page(None), vec![staged_space_post()])
            .unwrap();
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM space_sync_pending_verification",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM space_sync_stage", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM post", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn terminal_space_staging_preserves_the_resumable_cursor() {
        let mut store = EncryptedStore::open_memory(key(7)).unwrap();
        store
            .stage_space_page(
                space_stage_page(Some("firehose:8")),
                vec![staged_space_post()],
            )
            .unwrap();
        assert_eq!(
            store
                .connection
                .query_row("SELECT cursor FROM space_cursor", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "firehose:8"
        );
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM space_sync_pending_verification",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );

        store
            .stage_space_page(space_stage_page(None), Vec::new())
            .unwrap();
        assert_eq!(
            store
                .connection
                .query_row("SELECT cursor FROM space_cursor", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "firehose:8"
        );
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM space_sync_pending_verification",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn space_staging_rejects_a_record_outside_its_space_atomically() {
        let mut store = EncryptedStore::open_memory(key(7)).unwrap();
        let invalid = SpaceStageMutation::Delete {
            uri: "at://did:web:stratos.example/space/zone.stratos.space.feed/red-tail/did:plc:spikespiegel/zone.stratos.feed.post/see-you".to_string(),
        };

        assert!(matches!(
            store.stage_space_page(
                space_stage_page(Some("firehose:8")),
                vec![staged_space_post(), invalid]
            ),
            Err(StoreError::InvalidProjectionMutation)
        ));
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM space_sync_stage", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM space_cursor", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn promotion_publishes_a_verified_terminal_stage_and_keeps_its_cursor() {
        let mut store = EncryptedStore::open_memory(key(7)).unwrap();
        store
            .stage_space_page(
                space_stage_page(Some("firehose:8")),
                vec![staged_space_post()],
            )
            .unwrap();
        store
            .stage_space_page(space_stage_page(None), Vec::new())
            .unwrap();

        store
            .promote_verified_space_stage(
                "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop",
                "did:plc:spikespiegel",
                "1998-04-04T00:00:00.000Z",
            )
            .unwrap();

        assert_eq!(
            store
                .list_posts_by_boundary("bebop", None, 50, "1998-04-03T12:00:00.000Z")
                .unwrap()
                .posts
                .len(),
            1
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT cursor FROM space_cursor", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "firehose:8"
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM space_sync_stage", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM space_sync_pending_verification",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn promotion_rejects_a_partial_space_stage_without_publishing_it() {
        let mut store = EncryptedStore::open_memory(key(7)).unwrap();
        store
            .stage_space_page(
                space_stage_page(Some("firehose:8")),
                vec![staged_space_post()],
            )
            .unwrap();

        assert!(matches!(
            store.promote_verified_space_stage(
                "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop",
                "did:plc:spikespiegel",
                "1998-04-04T00:00:00.000Z",
            ),
            Err(StoreError::UnverifiedSpaceStage)
        ));
        assert!(
            store
                .list_posts_by_boundary("bebop", None, 50, "1998-04-03T12:00:00.000Z")
                .unwrap()
                .posts
                .is_empty()
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM space_sync_stage", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn promotion_processes_staged_records_in_bounded_batches() {
        let mut store = EncryptedStore::open_memory(key(7)).unwrap();
        let mutations = (0..=usize::from(super::MAX_SPACE_PROMOTION_BATCH))
            .map(|index| SpaceStageMutation::Upsert {
                uri: format!(
                    "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop/did:plc:spikespiegel/zone.stratos.feed.post/{index}"
                ),
                cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
                sort_at: "1998-04-03T00:00:00.000Z".to_string(),
                indexed_at: "1998-04-03T00:00:01.000Z".to_string(),
                record_json: br#"{\"text\":\"Bang\"}"#.to_vec(),
                blob_refs_json: b"[]".to_vec(),
            })
            .collect();
        store
            .stage_space_page(space_stage_page(None), mutations)
            .unwrap();

        store
            .promote_verified_space_stage(
                "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop",
                "did:plc:spikespiegel",
                "1998-04-04T00:00:00.000Z",
            )
            .unwrap();
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM post", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            i64::from(super::MAX_SPACE_PROMOTION_BATCH) + 1
        );
    }

    #[test]
    fn promotion_applies_a_verified_tombstone() {
        let mut store = EncryptedStore::open_memory(key(7)).unwrap();
        store
            .stage_space_page(space_stage_page(None), vec![staged_space_post()])
            .unwrap();
        store
            .promote_verified_space_stage(
                "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop",
                "did:plc:spikespiegel",
                "1998-04-04T00:00:00.000Z",
            )
            .unwrap();
        let staged_delete = SpaceStageMutation::Delete {
            uri: "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop/did:plc:spikespiegel/zone.stratos.feed.post/see-you".to_string(),
        };
        store
            .stage_space_page(space_stage_page(None), vec![staged_delete])
            .unwrap();

        store
            .promote_verified_space_stage(
                "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop",
                "did:plc:spikespiegel",
                "1998-04-04T00:00:00.000Z",
            )
            .unwrap();
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM post", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn loads_an_owner_only_hex_key_file() {
        let path = write_secret_file(
            "secret-key",
            b"0707070707070707070707070707070707070707070707070707070707070707\n",
            0o600,
        );
        assert_eq!(
            format!("{:?}", StorageKey::from_secret_file(&path).unwrap()),
            "StorageKey([REDACTED])"
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_permissive_or_malformed_secret_files() {
        let permissive = write_secret_file(
            "permissive-secret-key",
            b"0707070707070707070707070707070707070707070707070707070707070707",
            0o644,
        );
        assert!(matches!(
            StorageKey::from_secret_file(&permissive),
            Err(super::StoreError::InsecureKeyFile)
        ));
        fs::remove_file(permissive).unwrap();

        let malformed = write_secret_file("malformed-secret-key", b"not-a-key", 0o600);
        assert!(matches!(
            StorageKey::from_secret_file(&malformed),
            Err(super::StoreError::InvalidKeyFile)
        ));
        fs::remove_file(malformed).unwrap();

        let oversized = write_secret_file(
            "oversized-secret-key",
            b"07070707070707070707070707070707070707070707070707070707070707070",
            0o600,
        );
        assert!(matches!(
            StorageKey::from_secret_file(&oversized),
            Err(super::StoreError::InvalidKeyFile)
        ));
        fs::remove_file(oversized).unwrap();
    }

    #[test]
    fn rejects_symlinked_secret_files() {
        let target = write_secret_file(
            "secret-key-target",
            b"0707070707070707070707070707070707070707070707070707070707070707",
            0o600,
        );
        let link = temporary_path("secret-key-link");
        let _ = fs::remove_file(&link);
        symlink(&target, &link).unwrap();

        assert!(matches!(
            StorageKey::from_secret_file(&link),
            Err(super::StoreError::KeyFileAccess)
        ));
        fs::remove_file(link).unwrap();
        fs::remove_file(target).unwrap();
    }

    #[test]
    fn rejects_secret_files_under_symlinked_directories() {
        let target_directory = temporary_path("secret-key-directory");
        let _ = fs::remove_dir_all(&target_directory);
        fs::create_dir(&target_directory).unwrap();
        let target = target_directory.join("key");
        fs::write(
            &target,
            b"0707070707070707070707070707070707070707070707070707070707070707",
        )
        .unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        let link = temporary_path("secret-key-directory-link");
        let _ = fs::remove_file(&link);
        symlink(&target_directory, &link).unwrap();

        assert!(matches!(
            StorageKey::from_secret_file(&link.join("key")),
            Err(super::StoreError::KeyFileAccess)
        ));
        fs::remove_file(link).unwrap();
        fs::remove_dir_all(target_directory).unwrap();
    }
}
