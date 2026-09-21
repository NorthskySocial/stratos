use std::{
    env,
    path::{Path, PathBuf},
};

use crate::feeds::{FeedRegistry, FeedRegistryLoadError, load_feed_registry};
use crate::service_auth::ServiceSigningKey;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageProfile {
    Memory,
    EncryptedVolume {
        database_path: PathBuf,
        key_path: PathBuf,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeedgenConfig {
    pub service_did: String,
    pub public_url: String,
    pub public_key_multibase: String,
    pub signing_key: ServiceSigningKey,
    pub plc_url: String,
    pub storage: StorageProfile,
}

#[derive(Debug, Eq, PartialEq)]
pub enum ConfigError {
    Missing(&'static str),
    InvalidSigningKey,
    UnsupportedStorageBackend,
    InvalidStorageProfile,
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing(name) => {
                write!(formatter, "missing required environment variable {name}")
            }
            Self::UnsupportedStorageBackend => {
                formatter.write_str("only sqlite storage is supported by Feedgen NG")
            }
            Self::InvalidSigningKey => formatter.write_str("invalid Feedgen NG signing key"),
            Self::InvalidStorageProfile => {
                formatter.write_str("invalid Feedgen NG storage profile")
            }
        }
    }
}

impl std::error::Error for ConfigError {}

impl FeedgenConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let mut config = Self::from_values(
            env::var("FEEDGEN_SERVICE_DID").ok(),
            env::var("FEEDGEN_PUBLIC_URL").ok(),
            env::var("FEEDGEN_PUBLIC_KEY_MULTIBASE").ok(),
            env::var("FEEDGEN_SIGNING_KEY").ok(),
            StorageValues {
                backend: env::var("FEEDGEN_STORAGE_BACKEND").ok(),
                profile: env::var("FEEDGEN_STORAGE_PROFILE").ok(),
                sqlite_path: env::var("FEEDGEN_SQLITE_PATH").ok(),
                key_path: env::var("FEEDGEN_STORAGE_KEY_PATH").ok(),
            },
        )?;
        config.plc_url = env::var("FEEDGEN_PLC_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "https://plc.directory".to_owned());
        Ok(config)
    }

    pub fn load_feed_registry_from_env() -> Result<FeedRegistry, FeedRegistryLoadError> {
        load_feed_registry_from_values(
            env::var("FEEDGEN_FEEDS_FILE").ok(),
            env::var("FEEDGEN_FEEDS_JSON").ok(),
            env::var("FEEDGEN_FEEDS_YAML").ok(),
        )
    }
}

fn load_feed_registry_from_values(
    file: Option<String>,
    inline_json: Option<String>,
    inline_yaml: Option<String>,
) -> Result<FeedRegistry, FeedRegistryLoadError> {
    load_feed_registry(file.map(PathBuf::from), inline_json, inline_yaml)
}

impl FeedgenConfig {
    fn from_values(
        service_did: Option<String>,
        public_url: Option<String>,
        public_key_multibase: Option<String>,
        signing_key: Option<String>,
        storage: StorageValues,
    ) -> Result<Self, ConfigError> {
        Ok(Self {
            service_did: required_value(service_did, "FEEDGEN_SERVICE_DID")?,
            public_url: required_value(public_url, "FEEDGEN_PUBLIC_URL")?,
            public_key_multibase: required_value(
                public_key_multibase,
                "FEEDGEN_PUBLIC_KEY_MULTIBASE",
            )?,
            signing_key: ServiceSigningKey::from_hex(&required_value(
                signing_key,
                "FEEDGEN_SIGNING_KEY",
            )?)
            .map_err(|_| ConfigError::InvalidSigningKey)?,
            plc_url: "https://plc.directory".to_owned(),
            storage: parse_storage(
                storage.backend,
                storage.profile,
                storage.sqlite_path,
                storage.key_path,
            )?,
        })
    }
}

struct StorageValues {
    backend: Option<String>,
    profile: Option<String>,
    sqlite_path: Option<String>,
    key_path: Option<String>,
}

fn parse_storage(
    backend: Option<String>,
    profile: Option<String>,
    sqlite_path: Option<String>,
    key_path: Option<String>,
) -> Result<StorageProfile, ConfigError> {
    if backend.as_deref().is_some_and(|value| value != "sqlite") {
        return Err(ConfigError::UnsupportedStorageBackend);
    }
    match profile.as_deref().unwrap_or("ephemeral") {
        "ephemeral" => {
            if sqlite_path
                .as_deref()
                .is_some_and(|value| value != ":memory:")
            {
                return Err(ConfigError::InvalidStorageProfile);
            }
            Ok(StorageProfile::Memory)
        }
        "encrypted-volume" => {
            let database_path = required_value(sqlite_path, "FEEDGEN_SQLITE_PATH")?;
            let database_path = PathBuf::from(database_path);
            if database_path == Path::new(":memory:") || !database_path.is_absolute() {
                return Err(ConfigError::InvalidStorageProfile);
            }
            let key_path = required_value(key_path, "FEEDGEN_STORAGE_KEY_PATH")?;
            let key_path = PathBuf::from(key_path);
            let Some(database_directory) = database_path.parent() else {
                return Err(ConfigError::InvalidStorageProfile);
            };
            if !key_path.is_absolute()
                || key_path == database_path
                || key_path.starts_with(database_directory)
            {
                return Err(ConfigError::InvalidStorageProfile);
            }
            Ok(StorageProfile::EncryptedVolume {
                database_path,
                key_path,
            })
        }
        _ => Err(ConfigError::InvalidStorageProfile),
    }
}

fn required_value(value: Option<String>, name: &'static str) -> Result<String, ConfigError> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or(ConfigError::Missing(name))
}

#[cfg(test)]
mod tests {
    use super::{FeedgenConfig, StorageValues, load_feed_registry_from_values};

    fn storage(
        backend: Option<&str>,
        profile: Option<&str>,
        sqlite_path: Option<&str>,
        key_path: Option<&str>,
    ) -> StorageValues {
        StorageValues {
            backend: backend.map(str::to_owned),
            profile: profile.map(str::to_owned),
            sqlite_path: sqlite_path.map(str::to_owned),
            key_path: key_path.map(str::to_owned),
        }
    }

    #[test]
    fn configuration_errors_name_the_missing_value() {
        assert_eq!(
            FeedgenConfig::from_values(
                None,
                Some("https://feedgen.example.test".to_string()),
                Some("zTestKey".to_string()),
                Some("11".repeat(32)),
                storage(None, None, None, None),
            )
            .unwrap_err()
            .to_string(),
            "missing required environment variable FEEDGEN_SERVICE_DID"
        );
    }

    #[test]
    fn rejects_unsupported_or_incomplete_durable_storage() {
        let base = || {
            (
                Some("did:web:feedgen.example.test".to_string()),
                Some("https://feedgen.example.test".to_string()),
                Some("zTestKey".to_string()),
                Some("11".repeat(32)),
            )
        };
        let (did, url, key, signing_key) = base();
        assert_eq!(
            FeedgenConfig::from_values(
                did,
                url,
                key,
                signing_key,
                storage(Some("postgres"), None, None, None),
            )
            .unwrap_err(),
            super::ConfigError::UnsupportedStorageBackend
        );
        let (did, url, key, signing_key) = base();
        assert_eq!(
            FeedgenConfig::from_values(
                did,
                url,
                key,
                signing_key,
                storage(None, Some("encrypted-volume"), Some(":memory:"), None),
            )
            .unwrap_err(),
            super::ConfigError::InvalidStorageProfile
        );
        let (did, url, key, signing_key) = base();
        assert_eq!(
            FeedgenConfig::from_values(
                did,
                url,
                key,
                signing_key,
                storage(
                    None,
                    Some("encrypted-volume"),
                    Some("/var/lib/feedgen/feedgen.sqlite"),
                    Some("/var/lib/feedgen/key"),
                ),
            )
            .unwrap_err(),
            super::ConfigError::InvalidStorageProfile
        );
    }

    #[test]
    fn loads_the_catalogue_before_startup_from_the_configured_source() {
        let registry = load_feed_registry_from_values(
            None,
            Some(r#"{"feeds":[{"id":"bebop","boundary":"bebop"}]}"#.to_string()),
            None,
        )
        .unwrap();
        assert_eq!(registry.get("bebop").unwrap().boundary, "bebop");
    }
}
