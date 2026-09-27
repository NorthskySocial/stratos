use super::*;

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

    pub fn interrupt_handle(&self) -> StoreInterrupt {
        self.interrupt.clone()
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
        connection
            .busy_timeout(SQLITE_BUSY_TIMEOUT)
            .map_err(StoreError::Open)?;
        let cipher_version: String = connection
            .query_row("PRAGMA cipher_version", [], |row| row.get(0))
            .map_err(StoreError::Open)?;
        if cipher_version.is_empty() {
            return Err(StoreError::CipherUnavailable);
        }
        migrations::apply(&mut connection).map_err(StoreError::Open)?;
        let interrupt = StoreInterrupt(Arc::new(connection.get_interrupt_handle()));
        Ok(Self {
            connection,
            interrupt,
        })
    }
}
