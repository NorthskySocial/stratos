use std::{fmt, path::Path};

use crate::{
    config::StorageProfile,
    store::{EncryptedStore, StorageKey, StoreError},
};

pub enum RuntimeError {
    Store(StoreError),
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Store(error) => write!(
                formatter,
                "Feedgen NG storage initialization failed: {error}"
            ),
        }
    }
}

impl fmt::Debug for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Store(error) => formatter.debug_tuple("Store").field(error).finish(),
        }
    }
}

impl std::error::Error for RuntimeError {}

pub fn open_projection_store(profile: &StorageProfile) -> Result<EncryptedStore, RuntimeError> {
    match profile {
        StorageProfile::Memory => EncryptedStore::open_memory(StorageKey::from_bytes([0; 32]))
            .map_err(RuntimeError::Store),
        StorageProfile::EncryptedVolume {
            database_path,
            key_path,
        } => open_encrypted_store(database_path, key_path),
    }
}

fn open_encrypted_store(
    database_path: &Path,
    key_path: &Path,
) -> Result<EncryptedStore, RuntimeError> {
    let key = StorageKey::from_secret_file(key_path).map_err(RuntimeError::Store)?;
    EncryptedStore::open(database_path, key).map_err(RuntimeError::Store)
}

#[cfg(test)]
mod tests {
    use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

    use crate::config::StorageProfile;

    use super::open_projection_store;

    fn temporary_directory() -> PathBuf {
        std::env::temp_dir().join(format!("stratos-feedgen-ng-runtime-{}", std::process::id()))
    }

    #[test]
    fn opens_an_ephemeral_projection_for_non_durable_profiles() {
        assert!(open_projection_store(&StorageProfile::Memory).is_ok());
    }

    #[test]
    fn opens_encrypted_volume_and_redacts_unsafe_key_failures() {
        let directory = temporary_directory();
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir(&directory).unwrap();
        let database_path = directory.join("projection.sqlite");
        let key_path = directory.join("projection.key");
        let key = "0707070707070707070707070707070707070707070707070707070707070707";
        fs::write(&key_path, key).unwrap();
        fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600)).unwrap();
        let profile = StorageProfile::EncryptedVolume {
            database_path: database_path.clone(),
            key_path: key_path.clone(),
        };

        assert!(open_projection_store(&profile).is_ok());
        assert!(database_path.exists());

        fs::set_permissions(&key_path, fs::Permissions::from_mode(0o644)).unwrap();
        let error = match open_projection_store(&profile) {
            Ok(_) => panic!("expected an unsafe key file to be rejected"),
            Err(error) => error,
        };
        assert_eq!(
            error.to_string(),
            "Feedgen NG storage initialization failed: storage key file permissions are unsafe"
        );
        assert!(!format!("{error:?}").contains(key));
        fs::remove_dir_all(directory).unwrap();
    }
}
