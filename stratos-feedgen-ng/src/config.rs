use std::{
    env,
    path::{Path, PathBuf},
};

use crate::feeds::{FeedRegistry, FeedRegistryLoadError, load_feed_registry};

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
    pub plc_url: String,
    pub storage: StorageProfile,
}

#[derive(Debug, Eq, PartialEq)]
pub enum ConfigError {
    Missing(&'static str),
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
            env::var("FEEDGEN_STORAGE_BACKEND").ok(),
            env::var("FEEDGEN_STORAGE_PROFILE").ok(),
            env::var("FEEDGEN_SQLITE_PATH").ok(),
            env::var("FEEDGEN_STORAGE_KEY_PATH").ok(),
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
        storage_backend: Option<String>,
        storage_profile: Option<String>,
        sqlite_path: Option<String>,
        key_path: Option<String>,
    ) -> Result<Self, ConfigError> {
        Ok(Self {
            service_did: required_value(service_did, "FEEDGEN_SERVICE_DID")?,
            public_url: required_value(public_url, "FEEDGEN_PUBLIC_URL")?,
            public_key_multibase: required_value(
                public_key_multibase,
                "FEEDGEN_PUBLIC_KEY_MULTIBASE",
            )?,
            plc_url: "https://plc.directory".to_owned(),
            storage: parse_storage(storage_backend, storage_profile, sqlite_path, key_path)?,
        })
    }
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
    use super::{FeedgenConfig, load_feed_registry_from_values};

    #[test]
    fn configuration_errors_name_the_missing_value() {
        assert_eq!(
            FeedgenConfig::from_values(
                None,
                Some("https://feedgen.example.test".to_string()),
                Some("zTestKey".to_string()),
                None,
                None,
                None,
                None,
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
            )
        };
        let (did, url, key) = base();
        assert_eq!(
            FeedgenConfig::from_values(
                did,
                url,
                key,
                Some("postgres".to_string()),
                None,
                None,
                None,
            )
            .unwrap_err(),
            super::ConfigError::UnsupportedStorageBackend
        );
        let (did, url, key) = base();
        assert_eq!(
            FeedgenConfig::from_values(
                did,
                url,
                key,
                None,
                Some("encrypted-volume".to_string()),
                Some(":memory:".to_string()),
                None,
            )
            .unwrap_err(),
            super::ConfigError::InvalidStorageProfile
        );
        let (did, url, key) = base();
        assert_eq!(
            FeedgenConfig::from_values(
                did,
                url,
                key,
                None,
                Some("encrypted-volume".to_string()),
                Some("/var/lib/feedgen/feedgen.sqlite".to_string()),
                Some("/var/lib/feedgen/key".to_string()),
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
