use std::{fmt, path::Path};

use rusqlite::{Connection, OpenFlags};

const STORAGE_KEY_BYTES: usize = 32;
const SQLITE_CACHE_KIB: u32 = 16 * 1024;

pub struct StorageKey([u8; STORAGE_KEY_BYTES]);

impl StorageKey {
    pub fn from_bytes(value: [u8; STORAGE_KEY_BYTES]) -> Self {
        Self(value)
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

#[derive(Debug)]
pub enum StoreError {
    Open(rusqlite::Error),
    CipherUnavailable,
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Open(_) => formatter.write_str("encrypted store could not be opened"),
            Self::CipherUnavailable => formatter.write_str("SQLCipher is unavailable"),
        }
    }
}

impl std::error::Error for StoreError {}

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

    fn configure(connection: Connection, key: StorageKey) -> Result<Self, StoreError> {
        connection
            .execute_batch(&format!(
                "PRAGMA key = \"x'{}'\"; PRAGMA cipher_memory_security = ON; \
                 PRAGMA temp_store = MEMORY; PRAGMA cache_size = -{SQLITE_CACHE_KIB}; \
                 PRAGMA mmap_size = 0;",
                key.as_hex()
            ))
            .map_err(StoreError::Open)?;
        let cipher_version: String = connection
            .query_row("PRAGMA cipher_version", [], |row| row.get(0))
            .map_err(StoreError::Open)?;
        if cipher_version.is_empty() {
            return Err(StoreError::CipherUnavailable);
        }
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS feedgen_state (key TEXT PRIMARY KEY, value BLOB NOT NULL);",
            )
            .map_err(StoreError::Open)?;
        Ok(Self { connection })
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use rusqlite::Connection;

    use super::{EncryptedStore, StorageKey};

    fn key(byte: u8) -> StorageKey {
        StorageKey::from_bytes([byte; 32])
    }

    fn temporary_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("stratos-feedgen-ng-{name}-{}", std::process::id()))
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
                    "INSERT INTO feedgen_state (key, value) VALUES ('probe', X'01')",
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
                    "SELECT value FROM feedgen_state WHERE key = 'probe'",
                    [],
                    |row| { row.get::<_, Vec<u8>>(0) }
                )
                .unwrap(),
            vec![1]
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
}
