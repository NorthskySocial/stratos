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
    sync::Arc,
};

use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};

mod actor;
mod connection;
mod migrations;
mod read;
mod retention;
mod space;

const STORAGE_KEY_BYTES: usize = 32;
const MAX_ENCODED_KEY_BYTES: usize = STORAGE_KEY_BYTES * 2 + 1;
const SQLITE_CACHE_KIB: u32 = 16 * 1024;
const MAX_PURGE_BATCH: u16 = 512;
const MAX_SPACE_PROMOTION_BATCH: u16 = 512;
const MAX_ACTOR_ENROLLMENT_PAGE: u16 = 512;
const MAX_PDS_SPACE_MEMBER_PAGE: usize = 1_000;
const SQLITE_BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

pub struct StorageKey([u8; STORAGE_KEY_BYTES]);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProjectionCompaction {
    pub deleted: u64,
    pub has_more: bool,
}

impl StorageKey {
    pub fn from_bytes(value: [u8; STORAGE_KEY_BYTES]) -> Self {
        Self(value)
    }

    pub fn from_secret_file(path: &Path) -> Result<Self, StoreError> {
        let mut encoded = read_secret_file(path, MAX_ENCODED_KEY_BYTES)?;
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

pub(crate) fn read_secret_file(path: &Path, max_bytes: usize) -> Result<Vec<u8>, StoreError> {
    let mut file = open_secret_file(path)?;
    validate_secret_file(&file)?;
    let mut contents = Vec::with_capacity(max_bytes);
    file.by_ref()
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut contents)
        .map_err(|_| StoreError::KeyFileAccess)?;
    if contents.len() > max_bytes {
        contents.fill(0);
        return Err(StoreError::InvalidKeyFile);
    }
    Ok(contents)
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
    EnrollmentConflict,
    UnverifiedSpaceStage,
    UnauthorizedSpaceMember,
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
            Self::EnrollmentConflict => "EnrollmentConflict",
            Self::UnverifiedSpaceStage => "UnverifiedSpaceStage",
            Self::UnauthorizedSpaceMember => "UnauthorizedSpaceMember",
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
            Self::EnrollmentConflict => {
                formatter.write_str("actor enrollment conflicts at the same observation time")
            }
            Self::UnverifiedSpaceStage => {
                formatter.write_str("space stage has not completed verification")
            }
            Self::UnauthorizedSpaceMember => {
                formatter.write_str("space member is no longer authorized")
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

#[derive(Clone)]
pub struct StoreInterrupt(Arc<rusqlite::InterruptHandle>);

impl StoreInterrupt {
    pub fn interrupt(&self) {
        self.0.interrupt();
    }
}

pub struct EncryptedStore {
    connection: Connection,
    interrupt: StoreInterrupt,
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActorEnrollment {
    pub did: String,
    pub boundaries: Vec<String>,
    pub observed_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActorSyncState {
    pub boundaries: Vec<String>,
    pub cursor: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnrollmentReconciliation {
    pub removed_boundaries: Vec<String>,
    pub removed_posts: u64,
    pub enrolled: bool,
}

/// The authority-derived PDS members permitted to supply space records for a
/// boundary. This is distinct from an actor's own enrollment boundaries.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PdsSpaceMember {
    pub did: String,
}

struct StoredActorEnrollment {
    enrollment: Option<ActorEnrollment>,
    observed_at: String,
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
    pub blob_refs_json: Vec<u8>,
    pub boundaries: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlobPost {
    pub uri: String,
    pub author_did: String,
    pub blob_refs_json: Vec<u8>,
    pub boundaries: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeedPage {
    pub posts: Vec<FeedPost>,
    pub cursor: Option<crate::cursor::FeedCursor>,
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

fn load_actor_enrollment(
    transaction: &rusqlite::Transaction<'_>,
    did: &str,
) -> Result<Option<StoredActorEnrollment>, StoreError> {
    transaction
        .query_row(
            "SELECT did, boundaries_json, observed_at, enrolled FROM actor_enrollment WHERE did = ?1",
            [did],
            |row| {
                let boundaries: Vec<String> = serde_json::from_slice(&row.get::<_, Vec<u8>>(1)?)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?;
                let observed_at: String = row.get(2)?;
                let enrolled: bool = row.get(3)?;
                Ok(StoredActorEnrollment {
                    enrollment: enrolled.then_some(ActorEnrollment {
                        did: row.get(0)?,
                        boundaries,
                        observed_at: observed_at.clone(),
                    }),
                    observed_at,
                })
            },
        )
        .optional()
        .map_err(StoreError::Open)
}

fn validate_actor_enrollment(enrollment: &ActorEnrollment) -> Result<(), StoreError> {
    if enrollment.boundaries.len() > 128
        || enrollment
            .boundaries
            .iter()
            .any(|boundary| boundary.is_empty() || boundary.len() > 256 || !boundary.is_ascii())
        || !is_utc_timestamp(&enrollment.observed_at)
    {
        return Err(StoreError::InvalidProjectionMutation);
    }
    let unique = enrollment
        .boundaries
        .iter()
        .collect::<std::collections::BTreeSet<_>>();
    if unique.len() != enrollment.boundaries.len() {
        return Err(StoreError::InvalidProjectionMutation);
    }
    Ok(())
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
                "DELETE FROM space_sync_pending_verification WHERE space_uri = ?1 AND did = ?2",
                params![page.space_uri, page.actor_did],
            )
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "INSERT INTO space_sync_stage_cursor (space_uri, did, boundary, cursor, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
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

fn promote_space_stage_transaction(
    transaction: &rusqlite::Transaction<'_>,
    space_uri: &str,
    actor_did: &str,
    retained_at: &str,
) -> Result<(), StoreError> {
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
            load_space_stage_rows(transaction, space_uri, actor_did, after_uri.as_deref())?;
        let Some(last_uri) = stages.last().map(|stage| stage.uri.clone()) else {
            break;
        };
        for stage in stages {
            apply_verified_space_stage_row(transaction, space_uri, actor_did, retained_at, stage)?;
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
            "INSERT INTO space_cursor (space_uri, did, boundary, cursor, updated_at)
             SELECT space_uri, did, boundary, cursor, updated_at
             FROM space_sync_stage_cursor WHERE space_uri = ?1 AND did = ?2
             ON CONFLICT(space_uri, did) DO UPDATE SET boundary = excluded.boundary,
               cursor = excluded.cursor, updated_at = excluded.updated_at",
            params![space_uri, actor_did],
        )
        .map_err(StoreError::Open)?;
    transaction
        .execute(
            "DELETE FROM space_sync_stage_cursor WHERE space_uri = ?1 AND did = ?2",
            params![space_uri, actor_did],
        )
        .map_err(StoreError::Open)?;
    transaction
        .execute(
            "DELETE FROM space_sync_pending_verification WHERE space_uri = ?1 AND did = ?2",
            params![space_uri, actor_did],
        )
        .map_err(StoreError::Open)?;
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
        blob_refs_json: row.get(6)?,
        boundaries: serde_json::from_str(&row.get::<_, String>(7)?)
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

pub(crate) fn is_utc_timestamp(value: &str) -> bool {
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
mod tests;
