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
    SpaceStageLimit,
    ExpiredSpaceStage,
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
            Self::SpaceStageLimit => "SpaceStageLimit",
            Self::ExpiredSpaceStage => "ExpiredSpaceStage",
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
            Self::SpaceStageLimit => formatter.write_str("space stage exceeds the storage budget"),
            Self::ExpiredSpaceStage => formatter.write_str("space stage has expired"),
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

pub(crate) fn is_post_sort_timestamp(value: &str) -> bool {
    value.len() <= 40
        && time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
            .is_ok_and(|timestamp| timestamp.offset().whole_seconds() == 0)
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
            || !is_post_sort_timestamp(&post.sort_at)
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
