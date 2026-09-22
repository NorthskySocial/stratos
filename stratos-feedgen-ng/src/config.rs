use std::{
    env,
    path::{Path, PathBuf},
    time::Duration,
};

use crate::feeds::{FeedRegistry, FeedRegistryLoadError, load_feed_registry};
use crate::service_auth::ServiceSigningKey;

pub const MAX_ACTOR_CONNECTIONS: u16 = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageProfile {
    Memory,
    EncryptedVolume {
        database_path: PathBuf,
        key_path: PathBuf,
    },
}

/// Bounds how long and how much encrypted projection data may remain local.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionRetention {
    pub max_age: Duration,
    pub max_bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeedgenConfig {
    pub service_did: String,
    pub public_url: String,
    pub public_key_multibase: String,
    pub signing_key: ServiceSigningKey,
    pub stratos_service_url: String,
    pub stratos_public_url: String,
    pub stratos_service_did: String,
    pub plc_url: String,
    pub storage: StorageProfile,
    pub retention: ProjectionRetention,
    pub actor_max_connections: u16,
}

#[derive(Debug, Eq, PartialEq)]
pub enum ConfigError {
    Missing(&'static str),
    InvalidSigningKey,
    InvalidStratosServiceUrl,
    UnsupportedStorageBackend,
    InvalidStorageProfile,
    InvalidProjectionRetention,
    InvalidActorConnectionLimit,
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
            Self::InvalidStratosServiceUrl => formatter.write_str("invalid Stratos service URL"),
            Self::InvalidStorageProfile => {
                formatter.write_str("invalid Feedgen NG storage profile")
            }
            Self::InvalidProjectionRetention => {
                formatter.write_str("invalid Feedgen NG projection retention configuration")
            }
            Self::InvalidActorConnectionLimit => {
                formatter.write_str("invalid Feedgen NG actor connection limit")
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
            env::var("STRATOS_SERVICE_URL").ok(),
            env::var("STRATOS_SERVICE_DID").ok(),
            StorageValues {
                backend: env::var("FEEDGEN_STORAGE_BACKEND").ok(),
                profile: env::var("FEEDGEN_STORAGE_PROFILE").ok(),
                sqlite_path: env::var("FEEDGEN_SQLITE_PATH").ok(),
                key_path: env::var("FEEDGEN_STORAGE_KEY_PATH").ok(),
                projection_max_age_ms: env::var("FEEDGEN_PROJECTION_MAX_AGE_MS").ok(),
                projection_max_bytes: env::var("FEEDGEN_PROJECTION_MAX_BYTES").ok(),
            },
        )?;
        config.plc_url = env::var("FEEDGEN_PLC_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "https://plc.directory".to_owned());
        config.stratos_public_url = env::var("STRATOS_PUBLIC_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(normalize_service_url)
            .transpose()?
            .unwrap_or_else(|| config.stratos_service_url.clone());
        config.actor_max_connections =
            parse_actor_connection_limit(env::var("FEEDGEN_ACTOR_SYNC_MAX_CONNECTIONS").ok())?;
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
        stratos_service_url: Option<String>,
        stratos_service_did: Option<String>,
        storage: StorageValues,
    ) -> Result<Self, ConfigError> {
        let StorageValues {
            backend,
            profile,
            sqlite_path,
            key_path,
            projection_max_age_ms,
            projection_max_bytes,
        } = storage;
        let storage = parse_storage(backend, profile, sqlite_path, key_path)?;
        let retention = parse_retention(&storage, projection_max_age_ms, projection_max_bytes)?;
        let stratos_service_url =
            normalize_service_url(required_value(stratos_service_url, "STRATOS_SERVICE_URL")?)?;
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
            stratos_public_url: stratos_service_url.clone(),
            stratos_service_url,
            stratos_service_did: required_value(stratos_service_did, "STRATOS_SERVICE_DID")?,
            plc_url: "https://plc.directory".to_owned(),
            storage,
            retention,
            actor_max_connections: 8,
        })
    }
}

fn normalize_service_url(value: String) -> Result<String, ConfigError> {
    let parsed = url::Url::parse(&value).map_err(|_| ConfigError::InvalidStratosServiceUrl)?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(ConfigError::InvalidStratosServiceUrl);
    }
    Ok(value.trim_end_matches('/').to_owned())
}

struct StorageValues {
    backend: Option<String>,
    profile: Option<String>,
    sqlite_path: Option<String>,
    key_path: Option<String>,
    projection_max_age_ms: Option<String>,
    projection_max_bytes: Option<String>,
}

const MEMORY_RETENTION_MAX_AGE: Duration = Duration::from_secs(60 * 60);
const MEMORY_RETENTION_MAX_BYTES: u64 = 16 * 1024 * 1024;

fn parse_retention(
    storage: &StorageProfile,
    max_age_ms: Option<String>,
    max_bytes: Option<String>,
) -> Result<ProjectionRetention, ConfigError> {
    if matches!(storage, StorageProfile::Memory) {
        return Ok(ProjectionRetention {
            max_age: MEMORY_RETENTION_MAX_AGE,
            max_bytes: MEMORY_RETENTION_MAX_BYTES,
        });
    }
    let max_age_ms = required_positive_u64(max_age_ms, "FEEDGEN_PROJECTION_MAX_AGE_MS")?;
    let max_bytes = required_positive_u64(max_bytes, "FEEDGEN_PROJECTION_MAX_BYTES")?;
    Ok(ProjectionRetention {
        max_age: Duration::from_millis(max_age_ms),
        max_bytes,
    })
}

fn required_positive_u64(value: Option<String>, name: &'static str) -> Result<u64, ConfigError> {
    let value = required_value(value, name)?;
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value != 0)
        .ok_or(ConfigError::InvalidProjectionRetention)
}

fn parse_actor_connection_limit(value: Option<String>) -> Result<u16, ConfigError> {
    let Some(value) = value else {
        return Ok(8);
    };
    value
        .parse::<u16>()
        .ok()
        .filter(|value| (1..=MAX_ACTOR_CONNECTIONS).contains(value))
        .ok_or(ConfigError::InvalidActorConnectionLimit)
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
            projection_max_age_ms: None,
            projection_max_bytes: None,
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
                Some("https://stratos.example.test".to_string()),
                Some("did:web:stratos.example.test".to_string()),
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
                Some("https://stratos.example.test".to_string()),
                Some("did:web:stratos.example.test".to_string()),
            )
        };
        let (did, url, key, signing_key, stratos_url, stratos_did) = base();
        assert_eq!(
            FeedgenConfig::from_values(
                did,
                url,
                key,
                signing_key,
                stratos_url,
                stratos_did,
                storage(Some("postgres"), None, None, None),
            )
            .unwrap_err(),
            super::ConfigError::UnsupportedStorageBackend
        );
        let (did, url, key, signing_key, stratos_url, stratos_did) = base();
        assert_eq!(
            FeedgenConfig::from_values(
                did,
                url,
                key,
                signing_key,
                stratos_url,
                stratos_did,
                storage(None, Some("encrypted-volume"), Some(":memory:"), None),
            )
            .unwrap_err(),
            super::ConfigError::InvalidStorageProfile
        );
        let (did, url, key, signing_key, stratos_url, stratos_did) = base();
        assert_eq!(
            FeedgenConfig::from_values(
                did,
                url,
                key,
                signing_key,
                stratos_url,
                stratos_did,
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

    #[test]
    fn durable_storage_requires_explicit_bounded_projection_retention() {
        let base = || {
            (
                Some("did:web:feedgen.example.test".to_owned()),
                Some("https://feedgen.example.test".to_owned()),
                Some("zTestKey".to_owned()),
                Some("11".repeat(32)),
                Some("https://stratos.example.test".to_owned()),
                Some("did:web:stratos.example.test".to_owned()),
            )
        };
        let (did, url, key, signing_key, stratos_url, stratos_did) = base();
        let mut missing_retention = storage(
            None,
            Some("encrypted-volume"),
            Some("/var/lib/feedgen/projection.sqlite"),
            Some("/var/lib/secrets/feedgen.key"),
        );
        missing_retention.projection_max_age_ms = None;
        missing_retention.projection_max_bytes = Some("1024".to_owned());
        assert_eq!(
            FeedgenConfig::from_values(
                did,
                url,
                key,
                signing_key,
                stratos_url,
                stratos_did,
                missing_retention,
            )
            .unwrap_err()
            .to_string(),
            "missing required environment variable FEEDGEN_PROJECTION_MAX_AGE_MS"
        );

        let (did, url, key, signing_key, stratos_url, stratos_did) = base();
        let mut retention = storage(
            None,
            Some("encrypted-volume"),
            Some("/var/lib/feedgen/projection.sqlite"),
            Some("/var/lib/secrets/feedgen.key"),
        );
        retention.projection_max_age_ms = Some("60000".to_owned());
        retention.projection_max_bytes = Some("1024".to_owned());
        let config = FeedgenConfig::from_values(
            did,
            url,
            key,
            signing_key,
            stratos_url,
            stratos_did,
            retention,
        )
        .unwrap();
        assert_eq!(config.retention.max_age.as_secs(), 60);
        assert_eq!(config.retention.max_bytes, 1024);
        assert_eq!(config.actor_max_connections, 8);
        assert_eq!(config.stratos_public_url, "https://stratos.example.test");
    }

    #[test]
    fn bounds_the_actor_connection_limit_for_small_hosts() {
        assert_eq!(super::parse_actor_connection_limit(None).unwrap(), 8);
        assert_eq!(
            super::parse_actor_connection_limit(Some("64".to_owned())).unwrap(),
            64
        );
        assert_eq!(
            super::parse_actor_connection_limit(Some("65".to_owned())),
            Err(super::ConfigError::InvalidActorConnectionLimit)
        );
    }
}
