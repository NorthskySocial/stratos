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

use rusqlite::{Connection, OpenFlags};

mod migrations;

const STORAGE_KEY_BYTES: usize = 32;
const MAX_ENCODED_KEY_BYTES: usize = STORAGE_KEY_BYTES * 2 + 1;
const SQLITE_CACHE_KIB: u32 = 16 * 1024;

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
}

impl fmt::Debug for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Open(_) => "Open",
            Self::CipherUnavailable => "CipherUnavailable",
            Self::KeyFileAccess => "KeyFileAccess",
            Self::InsecureKeyFile => "InsecureKeyFile",
            Self::InvalidKeyFile => "InvalidKeyFile",
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

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
        path::PathBuf,
    };

    use rusqlite::Connection;

    use super::{EncryptedStore, StorageKey};

    fn key(byte: u8) -> StorageKey {
        StorageKey::from_bytes([byte; 32])
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
